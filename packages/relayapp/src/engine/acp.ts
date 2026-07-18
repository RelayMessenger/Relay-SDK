/**
 * ACP engine adapter. One adapter drives both engines by spawning the official
 * ACP wrappers over stdio (agentclientprotocol.com):
 *   claude → npx -y @agentclientprotocol/claude-agent-acp
 *   codex  → npx -y @agentclientprotocol/codex-acp
 *
 * ACP is the only interactive-approval path for Codex sessions the bridge
 * owns: `codex exec` hard-codes approval_policy=Never and rejects every
 * approval server-request, so no exec fallback exists here by design.
 *
 * Conversation → ACP session bindings persist in ~/.relayapp/sessions.json and
 * are re-attached with `session/load` when the agent advertises loadSession.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ClientContext,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  EngineAdapter,
  PermissionAsk,
  SessionRef,
  TurnCallbacks,
  TurnResult,
} from "./types.js";
import type { SessionStore } from "../store.js";

export const ADAPTER_PACKAGES: Record<string, string> = {
  claude: "@agentclientprotocol/claude-agent-acp",
  codex: "@agentclientprotocol/codex-acp",
};

interface TurnState {
  callbacks: TurnCallbacks;
  text: string[];
}

export class AcpEngine implements EngineAdapter {
  private child: ChildProcess | undefined;
  private connection: ClientConnection | undefined;
  private ctx: ClientContext | undefined;
  private initialization: Promise<void> | undefined;
  private loadSessionSupported = false;
  /** Live turn state keyed by ACP session id. */
  private readonly turns = new Map<string, TurnState>();
  /** conversation_id → ACP session id for the live process. */
  private readonly liveSessions = new Map<string, string>();
  private permissionSeq = 0;

  constructor(
    readonly engine: "claude" | "codex",
    private readonly sessions: SessionStore,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private async ensureConnected(): Promise<ClientContext> {
    if (this.ctx && this.child && this.child.exitCode === null) return this.ctx;
    if (!this.initialization) {
      this.initialization = this.connect();
      // A failed connect must not poison future attempts: clear the cached
      // promise on rejection so the next turn re-spawns.
      this.initialization.catch(() => {
        this.initialization = undefined;
      });
    }
    await this.initialization;
    return this.ctx!;
  }

  private async connect(): Promise<void> {
    const pkg = ADAPTER_PACKAGES[this.engine];
    this.log(`spawning ${pkg} via npx`);
    const child = spawn("npx", ["-y", pkg], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
      // Own process group so dispose() can kill the npx wrapper AND the
      // adapter grandchild it execs.
      detached: true,
    });
    this.child = child;
    child.on("error", (error) => {
      this.log(`${pkg} spawn error: ${error.message}`);
      this.resetConnection();
    });
    child.on("exit", (code) => {
      this.log(`${pkg} exited with code ${code}`);
      this.resetConnection();
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const app = client({ name: "relayapp" })
      .onRequest("session/request_permission", async (c) => this.handlePermission(c.params))
      .onNotification("session/update", (c) => {
        this.handleUpdate(c.params);
      });

    const connection = app.connect(stream);
    this.connection = connection;
    this.ctx = connection.agent;

    const init = await this.ctx.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "relayapp", version: "0.1.0-dev" },
      clientCapabilities: {},
    });
    this.loadSessionSupported = init.agentCapabilities?.loadSession === true;
    this.log(`initialized ${pkg} (protocol v${init.protocolVersion})`);
  }

  private resetConnection(): void {
    this.connection?.close();
    this.connection = undefined;
    this.ctx = undefined;
    this.initialization = undefined;
    this.liveSessions.clear();
    this.turns.clear();
  }

  private handleUpdate(notification: SessionNotification): void {
    const turn = this.turns.get(notification.sessionId);
    if (!turn) return;
    const update = notification.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      turn.text.push(update.content.text);
      turn.callbacks.onDelta?.(update.content.text);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      turn.callbacks.onToolEvent?.({
        kind: update.sessionUpdate,
        title: "title" in update ? (update.title ?? undefined) : undefined,
      });
    }
  }

  private async handlePermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const turn = this.turns.get(params.sessionId);
    if (!turn) {
      // No live turn owns this session (e.g. restart race) — safest is refusal.
      return { outcome: { outcome: "cancelled" } };
    }
    this.permissionSeq += 1;
    const ask: PermissionAsk = {
      requestId: `perm_${Date.now().toString(36)}_${this.permissionSeq}`,
      toolName: params.toolCall.title ?? params.toolCall.toolCallId,
      title: params.toolCall.title ?? undefined,
      options: params.options.map((option) => ({
        optionId: option.optionId,
        label: option.name,
        kind: option.kind,
      })),
    };
    const decision = await turn.callbacks.onPermissionAsk(ask);
    if (decision.behavior === "selected") {
      return { outcome: { outcome: "selected", optionId: decision.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  private async openSession(ctx: ClientContext, ref: SessionRef): Promise<string> {
    const live = this.liveSessions.get(ref.conversationId);
    if (live) return live;

    const stored = this.sessions.get(ref.conversationId);
    if (stored && stored.engine === this.engine && this.loadSessionSupported) {
      try {
        await ctx.request("session/load", {
          sessionId: stored.session_id,
          cwd: ref.cwd,
          mcpServers: [],
        });
        this.liveSessions.set(ref.conversationId, stored.session_id);
        return stored.session_id;
      } catch (error) {
        this.log(`session/load failed for ${ref.conversationId}, creating fresh: ${error}`);
        this.sessions.delete(ref.conversationId);
      }
    }

    const created = await ctx.request("session/new", { cwd: ref.cwd, mcpServers: [] });
    this.liveSessions.set(ref.conversationId, created.sessionId);
    this.sessions.set(ref.conversationId, {
      engine: this.engine,
      session_id: created.sessionId,
      cwd: ref.cwd,
      created_at: new Date().toISOString(),
    });
    return created.sessionId;
  }

  async startTurn(ref: SessionRef, promptText: string, callbacks: TurnCallbacks): Promise<TurnResult> {
    const ctx = await this.ensureConnected();
    const sessionId = await this.openSession(ctx, ref);
    const turn: TurnState = { callbacks, text: [] };
    this.turns.set(sessionId, turn);
    try {
      // No request timeout: a coding-agent turn can legitimately run for a
      // long time, and the JSON-RPC layer settles when the peer responds.
      const response = await ctx.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      });
      return { text: turn.text.join(""), stopReason: response.stopReason };
    } finally {
      this.turns.delete(sessionId);
    }
  }

  async abort(ref: SessionRef): Promise<void> {
    const sessionId = this.liveSessions.get(ref.conversationId);
    if (!sessionId || !this.ctx) return;
    await this.ctx.notify("session/cancel", { sessionId });
  }

  async dispose(): Promise<void> {
    this.resetConnection();
    if (this.child && this.child.exitCode === null && this.child.pid) {
      try {
        // Negative pid: signal the whole process group (npx + adapter).
        process.kill(-this.child.pid, "SIGTERM");
      } catch {
        this.child.kill("SIGTERM");
      }
    }
    this.child = undefined;
  }
}
