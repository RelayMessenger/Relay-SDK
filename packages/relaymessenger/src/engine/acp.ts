/**
 * ACP engine adapter. One adapter drives every supported runtime over stdio
 * (agentclientprotocol.com). Claude/Codex wrappers are exact lockfile-pinned
 * dependencies; other presets launch an already-installed user CLI. No
 * session executes a mutable registry "latest" package or a shell command.
 *
 * ACP is the only interactive-approval path for Codex sessions the bridge
 * owns: `codex exec` hard-codes approval_policy=Never and rejects every
 * approval server-request, so no exec fallback exists here by design.
 *
 * Conversation → ACP session bindings persist in the paired account runtime and
 * are re-attached with `session/load` when the agent advertises loadSession.
 */
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import crossSpawn from "cross-spawn";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ClientContext,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type {
  EngineAdapter,
  PermissionAsk,
  SessionRef,
  TurnCallbacks,
  TurnResult,
} from "./types.js";
import type { SessionStore } from "../store.js";
import { terminateProcessTree } from "./process.js";
import {
  EXTERNAL_ENGINE_SPECS,
  engineDisplayName,
  type EngineName,
} from "./catalog.js";

export const ADAPTER_PACKAGES: Record<string, string> = {
  claude: "@agentclientprotocol/claude-agent-acp",
  codex: "@agentclientprotocol/codex-acp",
};

/** Versions must exactly match package.json; tests enforce the lock. */
export const ADAPTER_VERSIONS: Record<string, string> = {
  claude: "0.59.0",
  codex: "1.1.4",
};

const require = createRequire(import.meta.url);

/** Resolve the installed, lockfile-pinned executable without invoking npm. */
export function adapterEntrypoint(engine: "claude" | "codex"): string {
  if (engine === "claude") {
    return require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
  }
  return require.resolve("@agentclientprotocol/codex-acp");
}

export interface EngineProcessSpec {
  command: string;
  args: string[];
  display: string;
}

/** Shell-free, deterministic process descriptor for one ACP runtime. */
export function engineProcessSpec(engine: EngineName): EngineProcessSpec {
  if (engine === "claude" || engine === "codex") {
    return {
      command: process.execPath,
      args: [adapterEntrypoint(engine)],
      display: `${ADAPTER_PACKAGES[engine]}@${ADAPTER_VERSIONS[engine]}`,
    };
  }
  const spec = EXTERNAL_ENGINE_SPECS[engine];
  return {
    command: spec.command,
    args: [...spec.args],
    display: `${spec.displayName} (${spec.command} ${spec.args.join(" ")})`,
  };
}

/**
 * Minimized environment for the adapter subprocess. The full parent env can
 * carry unrelated cloud/deploy/CI secrets; the adapter (and the agent it
 * execs) only needs the platform basics plus its own provider credentials.
 * Extend with RELAYMESSENGER_ENGINE_ENV="VAR1,VAR2,MYPREFIX_*". Deliberately no
 * "inherit" escape hatch exists: unrelated deploy and cloud credentials must
 * never be handed wholesale to a coding-agent subprocess.
 */
const ENGINE_ENV_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TZ",
  "TERM",
  "COLORTERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Windows process basics.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "OS",
  "WINDIR",
]);
const ENGINE_ENV_PREFIXES = [
  "LC_",
  "XDG_",
  // Engine/provider credentials and settings for supported local runtimes.
  "ANTHROPIC_",
  "CLAUDE_",
  "OPENAI_",
  "CODEX_",
  "HERMES_",
];

export function engineEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extra = (parent.RELAYMESSENGER_ENGINE_ENV ?? "").trim();
  const extraExact = new Set<string>();
  const extraPrefixes: string[] = [];
  for (const raw of extra.split(",")) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    if (entry.endsWith("*")) extraPrefixes.push(entry.slice(0, -1));
    else extraExact.add(entry);
  }
  const allowed = (key: string): boolean => {
    if (ENGINE_ENV_EXACT.has(key) || ENGINE_ENV_EXACT.has(key.toUpperCase())) return true;
    if (extraExact.has(key)) return true;
    return [...ENGINE_ENV_PREFIXES, ...extraPrefixes].some((prefix) => key.startsWith(prefix));
  };
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && allowed(key)) env[key] = value;
  }
  return env;
}

/**
 * Accumulates one turn's streamed assistant text. Chunks stream into the
 * current message segment; a tool-call boundary ends the segment, so the next
 * chunk starts a distinct message. Distinct segments join with a blank line —
 * a plain "" join would fuse back-to-back messages into one word
 * ("…the file." + "Created…" → "file.Created").
 */
export class AgentTextBuffer {
  private readonly segments: string[] = [];
  private open = false;

  append(chunk: string): void {
    if (!this.open) {
      this.segments.push("");
      this.open = true;
    }
    this.segments[this.segments.length - 1] += chunk;
  }

  /** Mark a message boundary: the next appended chunk starts a new segment. */
  endSegment(): void {
    this.open = false;
  }

  /** Segments trimmed (no doubled blank lines), empty segments dropped. */
  toString(): string {
    return this.segments
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .join("\n\n");
  }
}

interface TurnState {
  callbacks: TurnCallbacks;
  text: AgentTextBuffer;
  /** Latest complete view of each ACP tool call, assembled from deltas. */
  toolCalls: Map<string, ToolCallUpdate>;
}

/** Merge a sparse ACP tool-call update without erasing previously known fields. */
export function mergeToolCall(
  previous: ToolCallUpdate | undefined,
  incoming: ToolCallUpdate,
): ToolCallUpdate {
  const merged: Record<string, unknown> = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.toolCallId = incoming.toolCallId;
  return merged as ToolCallUpdate;
}

/**
 * Flatten the security-relevant parts of an ACP tool call — raw input,
 * affected locations, content — into one preview string for the approval
 * card. Length is clamped downstream (head + tail) by the card builder.
 */
export function permissionDetail(
  toolCall: RequestPermissionRequest["toolCall"],
): string | undefined {
  const parts: string[] = [];
  if (toolCall.rawInput !== undefined && toolCall.rawInput !== null) {
    try {
      parts.push(JSON.stringify(toolCall.rawInput));
    } catch {
      parts.push(String(toolCall.rawInput));
    }
  }
  if (Array.isArray(toolCall.locations) && toolCall.locations.length > 0) {
    parts.push(`paths: ${toolCall.locations.map((location) => location.path).join(", ")}`);
  }
  for (const content of toolCall.content ?? []) {
    if (content.type === "content" && content.content.type === "text") {
      parts.push(content.content.text);
    } else if (content.type === "diff") {
      parts.push(
        [
          `diff ${content.path}`,
          "--- before",
          content.oldText ?? "(new file)",
          "+++ after",
          content.newText,
        ].join("\n"),
      );
    } else if (content.type === "terminal") {
      parts.push(`terminal ${content.terminalId}`);
    }
  }
  const joined = parts.filter((part) => part && part.length > 0).join("\n");
  return joined.length > 0 ? joined : undefined;
}

/** True only when the phone can display the full operation being approved. */
export function permissionInputComplete(
  toolCall: RequestPermissionRequest["toolCall"],
): boolean {
  if (toolCall.rawInput !== undefined && toolCall.rawInput !== null) return true;
  return (toolCall.content ?? []).some(
    (content) =>
      content.type === "diff" &&
      typeof content.path === "string" &&
      typeof content.newText === "string",
  );
}

export class AcpEngine implements EngineAdapter {
  private child: ChildProcess | undefined;
  private connection: ClientConnection | undefined;
  private ctx: ClientContext | undefined;
  private initialization: Promise<void> | undefined;
  private loadSessionSupported = false;
  /** Live turn state keyed by ACP session id. */
  private readonly turns = new Map<string, TurnState>();
  /** conversation_id → ACP session + repository for the live process. */
  private readonly liveSessions = new Map<string, { sessionId: string; cwd: string }>();
  private permissionSeq = 0;

  constructor(
    readonly engine: EngineName,
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
    const processSpec = engineProcessSpec(this.engine);
    this.log(`spawning ${processSpec.display}`);
    const child = crossSpawn(processSpec.command, processSpec.args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: engineEnv(),
      // POSIX: own process group so dispose() reaches adapter descendants.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    child.on("error", (error) => {
      this.log(`${processSpec.display} spawn error: ${error.message}`);
      this.resetConnection();
    });
    child.on("exit", (code) => {
      this.log(`${processSpec.display} exited with code ${code}`);
      this.resetConnection();
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const app = client({ name: "relaymessenger" })
      .onRequest("session/request_permission", async (c) => this.handlePermission(c.params))
      .onNotification("session/update", (c) => {
        this.handleUpdate(c.params);
      });

    const connection = app.connect(stream);
    this.connection = connection;
    this.ctx = connection.agent;

    const init = await this.ctx.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "relaymessenger", version: "0.2.0" },
      clientCapabilities: {},
    });
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `${engineDisplayName(this.engine)} returned unsupported ACP protocol ` +
          `${init.protocolVersion}; relaymessenger requires ${PROTOCOL_VERSION}`,
      );
    }
    this.loadSessionSupported = init.agentCapabilities?.loadSession === true;
    this.log(`initialized ${processSpec.display} (protocol v${init.protocolVersion})`);
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
      turn.text.append(update.content.text);
      turn.callbacks.onDelta?.(update.content.text);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      // A tool call between text chunks means the next text is a new message.
      turn.text.endSegment();
      const { sessionUpdate: _sessionUpdate, ...incoming } = update;
      turn.toolCalls.set(
        incoming.toolCallId,
        mergeToolCall(turn.toolCalls.get(incoming.toolCallId), incoming),
      );
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
    const toolCall = mergeToolCall(
      turn.toolCalls.get(params.toolCall.toolCallId),
      params.toolCall,
    );
    turn.toolCalls.set(toolCall.toolCallId, toolCall);
    const ask: PermissionAsk = {
      requestId: `perm_${Date.now().toString(36)}_${this.permissionSeq}`,
      toolName: toolCall.title ?? toolCall.toolCallId,
      title: toolCall.title ?? undefined,
      // The card must show WHAT is being approved, not just a tool title: a
      // generic "Bash" with the command hidden turns Allow into a blind grant.
      inputPreview: permissionDetail(toolCall),
      inputComplete: permissionInputComplete(toolCall),
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
    if (live?.cwd === ref.cwd) return live.sessionId;
    if (live) this.liveSessions.delete(ref.conversationId);

    const stored = this.sessions.get(ref.conversationId);
    // Reuse only bindings from the same engine AND the same working
    // directory: reloading another repository's session would leak its
    // history/instructions into this tree and act against the wrong files.
    if (stored && stored.engine === this.engine && stored.cwd === ref.cwd && this.loadSessionSupported) {
      try {
        await ctx.request("session/load", {
          sessionId: stored.session_id,
          cwd: ref.cwd,
          mcpServers: [],
        });
        this.liveSessions.set(ref.conversationId, { sessionId: stored.session_id, cwd: ref.cwd });
        return stored.session_id;
      } catch (error) {
        this.log(`session/load failed for ${ref.conversationId}, creating fresh: ${error}`);
        this.sessions.delete(ref.conversationId);
      }
    }

    const created = await ctx.request("session/new", { cwd: ref.cwd, mcpServers: [] });
    this.liveSessions.set(ref.conversationId, { sessionId: created.sessionId, cwd: ref.cwd });
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
    const turn: TurnState = { callbacks, text: new AgentTextBuffer(), toolCalls: new Map() };
    this.turns.set(sessionId, turn);
    try {
      // No request timeout: a coding-agent turn can legitimately run for a
      // long time, and the JSON-RPC layer settles when the peer responds.
      const response = await ctx.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      });
      return { text: turn.text.toString(), stopReason: response.stopReason };
    } finally {
      this.turns.delete(sessionId);
    }
  }

  async abort(ref: SessionRef): Promise<void> {
    const live = this.liveSessions.get(ref.conversationId);
    if (!live || live.cwd !== ref.cwd || !this.ctx) return;
    await this.ctx.notify("session/cancel", { sessionId: live.sessionId });
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.resetConnection();
    this.child = undefined;
    if (child) await terminateProcessTree(child);
  }
}
