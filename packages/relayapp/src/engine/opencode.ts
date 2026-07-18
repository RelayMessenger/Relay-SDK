/**
 * opencode engine adapter: drives `opencode serve` over its HTTP API, modeled
 * on opencode's own Slack bot (packages/slack) and JS SDK server helper.
 *
 *  - Server: spawn `opencode serve --hostname=127.0.0.1 --port=0` and parse
 *    the "opencode server listening on <url>" line (config injected via
 *    OPENCODE_CONFIG_CONTENT, same as their SDK), or attach to an
 *    operator-run server via url + basic auth (OPENCODE_SERVER_PASSWORD /
 *    OPENCODE_SERVER_USERNAME semantics match opencode's own).
 *  - Sessions: POST /session per conversation; the binding persists in
 *    the paired account's sessions.json alongside ACP bindings and is validated
 *    with GET /session/:id before reuse.
 *  - Turns: POST /session/:id/prompt_async (fire-and-forget matches messaging
 *    semantics), then consume the SSE GET /event stream
 *    (server.connected/heartbeat framing). session.next.text.* deltas
 *    coalesce into the single finalized reply; session.next.tool.called is
 *    surfaced as a typing label; the turn ends on session.status idle.
 *  - permission.asked → onPermissionAsk; the phone's Allow/Deny maps onto
 *    POST /permission/:requestID/reply {reply: "once" | "reject"}.
 *  - question.asked → a single question with structured options is surfaced
 *    as a permission-style card (Allow = first option); anything richer is
 *    auto-rejected with a log so the turn cannot hang on the phone.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type {
  EngineAdapter,
  PermissionAsk,
  SessionRef,
  TurnCallbacks,
  TurnResult,
} from "./types.js";
import type { SessionStore } from "../store.js";
import { terminateProcessTree } from "./process.js";

export interface OpencodeServerConfig {
  /** Attach to an operator-run server instead of spawning one. */
  url?: string;
  username?: string;
  password?: string;
}

export interface OpencodeEngineOptions {
  server?: OpencodeServerConfig;
  binary?: string;
  /** OPENCODE_CONFIG_CONTENT for the spawned server (per their SDK). */
  config?: Record<string, unknown>;
  spawnTimeoutMs?: number;
  requestTimeoutMs?: number;
  streamConnectTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  turnTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Validate attach mode before credentials can be sent anywhere. */
export function normalizeOpencodeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("opencode server URL must be an absolute HTTP(S) origin");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("opencode server URL must use HTTPS (or HTTP on loopback)");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("opencode server URL must use HTTPS unless it is loopback");
  }
  if (url.username || url.password) {
    throw new Error("opencode server URL must not contain credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("opencode server URL must be an origin without path, query, or fragment");
  }
  return url.origin;
}

/** Resolve attach-mode settings from env (opencode's own variable names). */
export function opencodeServerFromEnv(
  base?: OpencodeServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpencodeServerConfig | undefined {
  const url = env.OPENCODE_SERVER_URL ?? base?.url;
  const password = env.OPENCODE_SERVER_PASSWORD ?? base?.password;
  const username = env.OPENCODE_SERVER_USERNAME ?? base?.username;
  if (!url && !password && !username) return undefined;
  return { url, username, password };
}

/** Parses the spawn banner: "opencode server listening on http://…". */
export function parseServerUrl(line: string): string | undefined {
  if (!line.startsWith("opencode server listening")) return undefined;
  return /on\s+(https?:\/\/[^\s]+)/.exec(line)?.[1];
}

interface OpencodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface EventStream {
  abort: AbortController;
  ready: Promise<void>;
  closed: boolean;
  failure?: Error;
}

interface TurnState {
  conversationId: string;
  directory: string;
  callbacks: TurnCallbacks;
  /** textID → accumulated text; text.ended replaces with the full value. */
  texts: Map<string, string>;
  /** Set once any activity for this session is seen; gates idle completion. */
  live: boolean;
  stopReason: string;
  lastError?: string;
  settled: boolean;
  resolve(result: TurnResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class OpencodeEngine implements EngineAdapter {
  readonly engine = "opencode";
  private readonly binary: string;
  private readonly attach?: OpencodeServerConfig;
  private readonly config: Record<string, unknown>;
  private readonly spawnTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly streamConnectTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private child: ChildProcess | undefined;
  private baseUrl: string | undefined;
  private starting: Promise<void> | undefined;
  /** One SSE subscription per working directory (server routes by directory). */
  private readonly streams = new Map<string, EventStream>();
  /** Live turn state keyed by opencode session id. */
  private readonly turns = new Map<string, TurnState>();
  /** conversation_id → opencode session + repository for this process. */
  private readonly liveSessions = new Map<string, { sessionId: string; cwd: string }>();

  constructor(
    private readonly sessions: SessionStore,
    options: OpencodeEngineOptions = {},
    private readonly log: (line: string) => void = () => {},
  ) {
    this.binary = options.binary ?? "opencode";
    this.attach = options.server?.url
      ? { ...options.server, url: normalizeOpencodeServerUrl(options.server.url) }
      : undefined;
    this.config = options.config ?? {};
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.streamConnectTimeoutMs = options.streamConnectTimeoutMs ?? 15_000;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 90_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 30 * 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // ---------------------------------------------------------------- server

  private authHeaders(): Record<string, string> {
    if (!this.attach?.password) return {};
    const username = this.attach.username ?? "opencode";
    const token = Buffer.from(`${username}:${this.attach.password}`).toString("base64");
    return { authorization: `Basic ${token}` };
  }

  private async ensureServer(): Promise<string> {
    if (this.attach?.url) return this.attach.url.replace(/\/$/, "");
    if (this.baseUrl && this.child && this.child.exitCode === null) return this.baseUrl;
    if (!this.starting) {
      this.starting = this.spawnServer();
      this.starting.catch(() => {
        this.starting = undefined;
      });
    }
    await this.starting;
    return this.baseUrl!;
  }

  private spawnServer(): Promise<void> {
    this.log(`spawning ${this.binary} serve`);
    const child = spawn(this.binary, ["serve", "--hostname=127.0.0.1", "--port=0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(this.config) },
      // POSIX: own process group so dispose() can kill the whole tree.
      detached: process.platform !== "win32",
      // npm-installed command shims are .cmd files on Windows.
      shell: process.platform === "win32",
      windowsHide: true,
    });
    this.child = child;
    child.on("exit", (code) => {
      this.log(`opencode server exited with code ${code}`);
      this.resetServer(new Error(`opencode server exited with code ${code}`));
    });

    return new Promise<void>((resolve, reject) => {
      let output = "";
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this.killChild();
        reject(new Error(`timeout waiting for opencode server after ${this.spawnTimeoutMs}ms`));
      }, this.spawnTimeoutMs);
      timer.unref?.();
      child.stdout!.on("data", (chunk: Buffer) => {
        if (resolved) return;
        output += chunk.toString();
        for (const line of output.split("\n")) {
          const url = parseServerUrl(line);
          if (url) {
            resolved = true;
            clearTimeout(timer);
            this.baseUrl = url;
            this.log(`opencode server listening on ${url}`);
            resolve();
            return;
          }
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("error", (error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`failed to spawn ${this.binary}: ${error.message}`));
      });
      child.on("exit", (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`opencode server exited with code ${code} before listening\n${output.trim()}`));
      });
    });
  }

  private killChild(): void {
    if (this.child && this.child.exitCode === null && this.child.pid) {
      if (process.platform === "win32") {
        this.child.kill();
      } else {
        try {
          process.kill(-this.child.pid, "SIGTERM");
        } catch {
          this.child.kill("SIGTERM");
        }
      }
    }
    this.child = undefined;
  }

  /** Server or stream loss: fail live turns so the supervisor sees the error. */
  private resetServer(error: Error): void {
    this.baseUrl = undefined;
    this.starting = undefined;
    this.child = undefined;
    this.liveSessions.clear();
    for (const stream of this.streams.values()) {
      stream.closed = true;
      stream.abort.abort();
    }
    this.streams.clear();
    for (const [sessionId, turn] of [...this.turns]) {
      this.turns.delete(sessionId);
      if (!turn.settled) {
        turn.settled = true;
        clearTimeout(turn.timer);
        turn.reject(error);
      }
    }
  }

  // ------------------------------------------------------------------ http

  private async request<T>(
    method: string,
    path: string,
    opts: { directory?: string; body?: unknown } = {},
  ): Promise<T> {
    const base = await this.ensureServer();
    const url = new URL(base + path);
    if (opts.directory) url.searchParams.set("directory", opts.directory);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          ...this.authHeaders(),
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`opencode ${method} ${path} timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`opencode ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T;
    }
  }

  // ------------------------------------------------------------ event feed

  private async ensureStream(directory: string): Promise<void> {
    const existing = this.streams.get(directory);
    if (existing && !existing.closed) return existing.ready;
    const abort = new AbortController();
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    // A never-consumed rejection (ready already resolved) must not crash.
    ready.catch(() => {});
    const stream: EventStream = { abort, ready, closed: false };
    this.streams.set(directory, stream);
    void this.readEvents(directory, stream, markReady, failReady);
    return ready;
  }

  private async readEvents(
    directory: string,
    stream: EventStream,
    markReady: () => void,
    failReady: (error: Error) => void,
  ): Promise<void> {
    let readySeen = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const failAfter = (message: string) => {
      stream.failure = new Error(message);
      stream.abort.abort();
    };
    const readyTimer = setTimeout(
      () => failAfter(`opencode event stream did not become ready after ${this.streamConnectTimeoutMs}ms`),
      this.streamConnectTimeoutMs,
    );
    readyTimer.unref?.();
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => failAfter(`opencode event stream was idle for ${this.streamIdleTimeoutMs}ms`),
        this.streamIdleTimeoutMs,
      );
      idleTimer.unref?.();
    };
    try {
      const base = await this.ensureServer();
      const url = new URL(`${base}/event`);
      url.searchParams.set("directory", directory);
      const response = await this.fetchImpl(url, {
        headers: { ...this.authHeaders(), accept: "text/event-stream" },
        signal: stream.abort.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`opencode GET /event failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (readySeen) resetIdleTimer();
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .map((line) => line.replace(/\r$/, ""))
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          let event: OpencodeEvent;
          try {
            event = JSON.parse(data) as OpencodeEvent;
          } catch {
            continue;
          }
          if (event.type === "server.connected" && !readySeen) {
            readySeen = true;
            clearTimeout(readyTimer);
            resetIdleTimer();
            markReady();
          }
          this.dispatch(directory, event);
        }
      }
      throw new Error("opencode event stream closed");
    } catch (error: any) {
      clearTimeout(readyTimer);
      if (idleTimer) clearTimeout(idleTimer);
      stream.closed = true;
      if (this.streams.get(directory) === stream) this.streams.delete(directory);
      if (stream.abort.signal.aborted && !stream.failure) return; // deliberate close
      const wrapped =
        stream.failure ??
        (error instanceof Error ? error : new Error(`opencode event stream error: ${error}`));
      failReady(wrapped);
      this.log(`event stream for ${directory} died: ${wrapped.message}`);
      // Turns blocked on this stream can never finish: surface the failure.
      for (const [sessionId, turn] of [...this.turns]) {
        if (turn.directory !== directory || turn.settled) continue;
        this.turns.delete(sessionId);
        turn.settled = true;
        turn.reject(new Error(`opencode server connection lost mid-turn: ${wrapped.message}`));
      }
    }
  }

  private dispatch(directory: string, event: OpencodeEvent): void {
    const props = event.properties ?? {};
    const sessionId = typeof props.sessionID === "string" ? props.sessionID : undefined;
    if (!sessionId) return;
    const turn = this.turns.get(sessionId);
    if (!turn) return;

    switch (event.type) {
      case "session.next.text.delta": {
        turn.live = true;
        const textId = String(props.textID ?? "text");
        const delta = typeof props.delta === "string" ? props.delta : "";
        turn.texts.set(textId, (turn.texts.get(textId) ?? "") + delta);
        turn.callbacks.onDelta?.(delta);
        return;
      }
      case "session.next.text.ended": {
        turn.live = true;
        // Full-value boundary: replaces whatever the deltas accumulated.
        if (typeof props.text === "string") {
          turn.texts.set(String(props.textID ?? "text"), props.text);
        }
        return;
      }
      case "session.next.tool.called": {
        turn.live = true;
        turn.callbacks.onToolEvent?.({
          kind: "tool_call",
          title: typeof props.tool === "string" ? props.tool : undefined,
        });
        return;
      }
      case "session.next.step.ended": {
        turn.live = true;
        if (typeof props.finish === "string") turn.stopReason = props.finish;
        return;
      }
      case "session.next.step.failed":
      case "session.error": {
        turn.live = true;
        turn.lastError = summarizeError(props.error ?? props);
        return;
      }
      case "session.status": {
        const status = props.status as { type?: string } | undefined;
        if (status?.type === "idle") {
          if (turn.live) this.finishTurn(sessionId, turn);
        } else if (status?.type) {
          turn.live = true;
        }
        return;
      }
      case "permission.asked": {
        void this.handlePermissionAsked(turn, props).catch((error) => {
          // An undelivered permission reply leaves the engine waiting forever
          // and the conversation queue blocked behind it: fail the turn so the
          // supervisor surfaces the error instead of stranding it.
          this.failTurn(sessionId, turn, `permission reply failed: ${error}`);
        });
        return;
      }
      case "question.asked": {
        void this.handleQuestionAsked(turn, props).catch((error) => {
          this.failTurn(sessionId, turn, `question reply failed: ${error}`);
        });
        return;
      }
      default:
        turn.live = true;
    }
  }

  private failTurn(sessionId: string, turn: TurnState, message: string): void {
    this.log(message);
    if (turn.settled) return;
    turn.settled = true;
    clearTimeout(turn.timer);
    this.turns.delete(sessionId);
    // The server may still be blocked on the permission/question whose reply
    // failed. Never reuse that session: abort best-effort and force the next
    // owner message onto a fresh session instead of queueing behind it.
    this.liveSessions.delete(turn.conversationId);
    this.sessions.delete(turn.conversationId);
    void this.request("POST", `/session/${sessionId}/abort`, { directory: turn.directory }).catch(
      (error) => this.log(`failed to abort stranded opencode session ${sessionId}: ${error}`),
    );
    turn.reject(new Error(`opencode turn failed: ${message}`));
  }

  private finishTurn(sessionId: string, turn: TurnState): void {
    if (turn.settled) return;
    turn.settled = true;
    clearTimeout(turn.timer);
    this.turns.delete(sessionId);
    const text = [...turn.texts.values()].filter((chunk) => chunk.length > 0).join("\n\n");
    if (text.length === 0 && turn.lastError) {
      turn.reject(new Error(`opencode turn failed: ${turn.lastError}`));
      return;
    }
    turn.resolve({ text, stopReason: turn.stopReason });
  }

  // ------------------------------------------------------------- approvals

  private async handlePermissionAsked(
    turn: TurnState,
    props: Record<string, unknown>,
  ): Promise<void> {
    const requestId = String(props.id ?? "");
    if (!requestId) return;
    const permission = typeof props.permission === "string" ? props.permission : "a tool";
    const patterns = Array.isArray(props.patterns) ? props.patterns.map(String) : [];
    const ask: PermissionAsk = {
      requestId,
      toolName: permission,
      title: patterns.length > 0 ? `${permission}: ${patterns.join(" ")}` : permission,
      inputPreview: opencodePermissionDetail(props),
      // OpenCode's current permission.asked contract exposes permission,
      // patterns, arbitrary metadata, always-patterns, and an optional tool
      // reference. It does not promise that metadata contains the complete raw
      // tool input. Relay therefore preserves every supplied detail without
      // truncation for diagnosis but never offers remote Allow.
      inputComplete: false,
      options: [
        { optionId: "reject", label: "Deny", kind: "reject_once" },
      ],
    };
    const decision = await turn.callbacks.onPermissionAsk(ask);
    const allow = ask.inputComplete !== false &&
      decision.behavior === "selected" &&
      decision.optionId === "once";
    await this.request("POST", `/permission/${requestId}/reply`, {
      directory: turn.directory,
      body: allow ? { reply: "once" } : { reply: "reject", message: "Denied from Relay" },
    });
  }

  private async handleQuestionAsked(
    turn: TurnState,
    props: Record<string, unknown>,
  ): Promise<void> {
    const requestId = String(props.id ?? "");
    if (!requestId) return;
    const questions = Array.isArray(props.questions) ? props.questions : [];
    const first = questions[0] as
      | { question?: string; header?: string; options?: Array<{ label?: string }> }
      | undefined;
    const firstOption = first?.options?.[0]?.label;
    // Cheap structured path: exactly one question with concrete options maps
    // onto the binary card (Allow = first option). Anything richer cannot be
    // represented, so skip it instead of hanging the turn on the phone.
    if (questions.length !== 1 || !firstOption) {
      this.log(`question ${requestId} not representable as a binary card — rejecting`);
      await this.request("POST", `/question/${requestId}/reject`, { directory: turn.directory });
      return;
    }
    const ask: PermissionAsk = {
      requestId,
      toolName: "question",
      title: `${first?.question ?? first?.header ?? "Question"} — Allow answers "${firstOption}"`,
      options: [
        { optionId: "accept", label: firstOption, kind: "allow_once" },
        { optionId: "reject", label: "Skip", kind: "reject_once" },
      ],
    };
    const decision = await turn.callbacks.onPermissionAsk(ask);
    if (decision.behavior === "selected" && decision.optionId === "accept") {
      await this.request("POST", `/question/${requestId}/reply`, {
        directory: turn.directory,
        body: { answers: [[firstOption]] },
      });
    } else {
      await this.request("POST", `/question/${requestId}/reject`, { directory: turn.directory });
    }
  }

  // -------------------------------------------------------------- sessions

  private async openSession(ref: SessionRef): Promise<string> {
    const live = this.liveSessions.get(ref.conversationId);
    if (live?.cwd === ref.cwd) return live.sessionId;
    if (live) this.liveSessions.delete(ref.conversationId);

    const stored = this.sessions.get(ref.conversationId);
    // Same-engine AND same-directory only: a binding from another repository
    // would reload that repo's history and act against the wrong tree.
    if (stored && stored.engine === this.engine && stored.cwd === ref.cwd) {
      try {
        await this.request("GET", `/session/${stored.session_id}`, { directory: ref.cwd });
        this.liveSessions.set(ref.conversationId, { sessionId: stored.session_id, cwd: ref.cwd });
        return stored.session_id;
      } catch (error) {
        this.log(`stored opencode session invalid for ${ref.conversationId}, creating fresh: ${error}`);
        this.sessions.delete(ref.conversationId);
      }
    }

    const created = await this.request<{ id: string }>("POST", "/session", {
      directory: ref.cwd,
      body: { title: `Relay ${ref.conversationId}` },
    });
    this.liveSessions.set(ref.conversationId, { sessionId: created.id, cwd: ref.cwd });
    this.sessions.set(ref.conversationId, {
      engine: this.engine,
      session_id: created.id,
      cwd: ref.cwd,
      created_at: new Date().toISOString(),
    });
    return created.id;
  }

  // ----------------------------------------------------------------- turns

  async startTurn(ref: SessionRef, promptText: string, callbacks: TurnCallbacks): Promise<TurnResult> {
    await this.ensureServer();
    await this.ensureStream(ref.cwd);
    const sessionId = await this.openSession(ref);

    return await new Promise<TurnResult>((resolve, reject) => {
      const turn = {} as TurnState;
      turn.timer = setTimeout(() => {
        this.failTurn(sessionId, turn, `lifecycle timed out after ${this.turnTimeoutMs}ms`);
      }, this.turnTimeoutMs);
      turn.timer.unref?.();
      Object.assign(turn, {
        conversationId: ref.conversationId,
        directory: ref.cwd,
        callbacks,
        texts: new Map(),
        live: false,
        stopReason: "end_turn",
        settled: false,
        resolve,
        reject,
      });
      this.turns.set(sessionId, turn);
      // Fire-and-forget prompt: the reply arrives via the event stream.
      this.request("POST", `/session/${sessionId}/prompt_async`, {
        directory: ref.cwd,
        body: { parts: [{ type: "text", text: promptText }] },
      }).catch((error) => {
        if (turn.settled) return;
        turn.settled = true;
        clearTimeout(turn.timer);
        this.turns.delete(sessionId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async abort(ref: SessionRef): Promise<void> {
    const live = this.liveSessions.get(ref.conversationId);
    if (!live || live.cwd !== ref.cwd) return;
    await this.request("POST", `/session/${live.sessionId}/abort`, { directory: ref.cwd }).catch((error) => {
      this.log(`abort failed for ${ref.conversationId}: ${error}`);
    });
  }

  async dispose(): Promise<void> {
    const child = this.child;
    for (const stream of this.streams.values()) {
      stream.closed = true;
      stream.abort.abort();
    }
    this.streams.clear();
    for (const [sessionId, turn] of [...this.turns]) {
      this.turns.delete(sessionId);
      if (!turn.settled) {
        turn.settled = true;
        clearTimeout(turn.timer);
        turn.reject(new Error("opencode engine disposed"));
      }
    }
    this.turns.clear();
    this.liveSessions.clear();
    this.child = undefined;
    if (child) await terminateProcessTree(child);
    this.baseUrl = undefined;
    this.starting = undefined;
  }
}

/** Preserve the complete public permission-event payload fields verbatim. */
export function opencodePermissionDetail(props: Record<string, unknown>): string {
  return JSON.stringify(
    {
      permission: typeof props.permission === "string" ? props.permission : null,
      patterns: Array.isArray(props.patterns) ? props.patterns : null,
      metadata:
        props.metadata && typeof props.metadata === "object" && !Array.isArray(props.metadata)
          ? props.metadata
          : null,
      always: Array.isArray(props.always) ? props.always : null,
      tool:
        props.tool && typeof props.tool === "object" && !Array.isArray(props.tool)
          ? props.tool
          : null,
    },
    null,
    2,
  );
}

function summarizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "name", "type", "_tag"]) {
      if (typeof record[key] === "string" && (record[key] as string).length > 0) {
        return record[key] as string;
      }
    }
    try {
      return JSON.stringify(error).slice(0, 300);
    } catch {
      /* fall through */
    }
  }
  return String(error);
}
