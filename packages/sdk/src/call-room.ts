import NodeWebSocket from "ws";
import type {
  Call,
  CallRoomClientFrame,
  CallRoomEndedFrame,
  CallRoomErrorCode,
  CallRoomErrorFrame,
  CallRoomIceServer,
  CallRoomIceServersFrame,
  CallRoomParticipant,
  CallRoomServerAnswerFrame,
  CallRoomServerFrame,
  CallRoomStateFrame,
  CallRoomSubscriptionOfferFrame,
  CallTerminalStatus,
} from "./types.js";
import type { WebSocketConstructor, WebSocketLike } from "./websocket.js";

/** Orange Meets heartbeat cadence (`app/hooks/useRoom.ts`, 5_000 ms). */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * PartySocket reconnect defaults (`partysocket/src/ws.ts` DEFAULT), PROTOCOL.md
 * section 5. No retry limit: the room stops only on a close that was asked for.
 */
const MIN_RECONNECTION_DELAY_MS = 3_000;
const RECONNECTION_DELAY_GROW_FACTOR = 1.3;
const MAX_RECONNECTION_DELAY_MS = 10_000;
const CONNECTION_TIMEOUT_MS = 4_000;
const MIN_UPTIME_MS = 5_000;
const CLIENT_PROTOCOL_ERROR = 4400;
const TERMINAL_STATUSES = new Set<CallTerminalStatus>([
  "completed", "no-answer", "canceled", "busy", "failed",
]);
/**
 * Server frame types this client decodes. Any other type is a frame a newer
 * Relay added: it is ignored and the socket stays open, as Orange Meets'
 * room client does (`app/hooks/useRoom.ts` `onMessage`: its `default` case
 * only breaks).
 */
const KNOWN_SERVER_FRAME_TYPES: ReadonlySet<string> = new Set([
  "heartbeat", "iceServers", "roomState", "answer", "offer", "ended", "error",
]);
const ROOM_ERROR_CODES = new Set<CallRoomErrorCode>([
  "invalid_frame", "not_allowed", "media_unavailable",
]);

export interface CallRoomOptions {
  /** Abort closes the signaling socket without ending the Call. */
  signal?: AbortSignal;
  /** Override the Node WebSocket implementation, primarily for tests. */
  WebSocket?: WebSocketConstructor;
  /** Client heartbeat cadence. Relay's room heartbeat frame has no payload. */
  heartbeatIntervalMs?: number;
  /**
   * Called once per unknown server frame type, which the room ignores.
   * Defaults to `console.warn`.
   */
  onWarning?: (message: string) => void;
}

export interface CallRoomCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

/**
 * The room socket dropped, or an attempt to open one failed, and the room
 * opens a new one after `delayMs`. Media rides the SFU, not this socket, so the
 * Call and its WebRTC session continue; nothing is re-offered.
 */
export interface CallRoomReconnectingEvent {
  /** 1 for the first retry; the count resets once a socket stays open 5 s. */
  attempt: number;
  delayMs: number;
  /** The close that caused the retry; absent when an attempt failed before opening. */
  close?: CallRoomCloseEvent;
  /** Why the failed attempt did not open (connect timeout, handshake error). */
  error?: Error;
}

export type CallRoomConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export type CallRoomEventMap = {
  open: [];
  reconnecting: [CallRoomReconnectingEvent];
  /** The room's STUN/TURN servers, sent after every accepted `join`, before its `roomState`. */
  iceServers: [CallRoomIceServersFrame];
  roomState: [CallRoomStateFrame];
  offer: [CallRoomSubscriptionOfferFrame];
  answer: [CallRoomServerAnswerFrame];
  ended: [CallRoomEndedFrame];
  error: [CallRoomErrorFrame | Error];
  /** The room socket closed and the room will not reopen it by itself. */
  close: [CallRoomCloseEvent];
};

type CallRoomEvent = keyof CallRoomEventMap;
type Listener<K extends CallRoomEvent> = (...args: CallRoomEventMap[K]) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
};

const validDescription = (
  value: unknown,
  type: "offer" | "answer",
): value is { type: typeof type; sdp: string } =>
  isRecord(value)
  && hasExactKeys(value, ["type", "sdp"])
  && value.type === type
  && typeof value.sdp === "string"
  && value.sdp.length > 0
  && value.sdp.length <= 65_536;

const validCall = (value: unknown): value is Call => {
  if (!isRecord(value)) return false;
  const status = value.status;
  return typeof value.id === "string"
    && typeof value.chat_id === "string"
    && (status === "ringing" || status === "in-progress" || TERMINAL_STATUSES.has(status as CallTerminalStatus));
};

const PARTICIPANT_KEYS = ["contact_id", "kind", "attached", "track", "muted", "connected"] as const;

/** `[]` before the participant's first offer, then `["audio"]` or `["audio", "video"]` (PROTOCOL.md section 3). */
const validTracks = (value: unknown): boolean =>
  Array.isArray(value)
  && value.length <= 2
  && value.every((name) => name === "audio" || name === "video")
  && new Set(value).size === value.length;

const validParticipant = (value: unknown): value is CallRoomParticipant =>
  isRecord(value)
  && (hasExactKeys(value, PARTICIPANT_KEYS)
    || hasExactKeys(value, [...PARTICIPANT_KEYS, "video", "tracks"]))
  && (value.video === undefined || typeof value.video === "boolean")
  && (value.tracks === undefined || validTracks(value.tracks))
  && typeof value.contact_id === "string"
  && (value.kind === "user" || value.kind === "agent")
  && typeof value.attached === "boolean"
  && (value.track === "audio" || value.track === null)
  && typeof value.muted === "boolean"
  && typeof value.connected === "boolean";

/** Contract `CallRoomIceServersFrame`: 1-8 servers, each 1-16 `stun:`/`turn:`/`turns:` URLs. */
const validIceServer = (value: unknown): value is CallRoomIceServer =>
  isRecord(value)
  && Object.keys(value).every((key) => key === "urls" || key === "username" || key === "credential")
  && Array.isArray(value.urls)
  && value.urls.length >= 1
  && value.urls.length <= 16
  && value.urls.every((url) => typeof url === "string" && /^(stun|turns?):/u.test(url))
  && (value.username === undefined || typeof value.username === "string")
  && (value.credential === undefined || typeof value.credential === "string");

/**
 * Validate one server frame before exposing it to application code. Returns
 * `null` for Relay's echoed heartbeat (not part of the public server-frame
 * union) and for a frame type this client does not know (a newer Relay's
 * frame, ignored). Throws for a known frame type whose shape is invalid.
 */
export const parseCallRoomServerFrame = (value: unknown): CallRoomServerFrame | null => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Relay Call room received an invalid frame.");
  }
  if (!KNOWN_SERVER_FRAME_TYPES.has(value.type)) return null;
  switch (value.type) {
    case "heartbeat":
      if (!hasExactKeys(value, ["type"])) break;
      return null;
    case "iceServers":
      if (!hasExactKeys(value, ["type", "ice_servers"])
        || !Array.isArray(value.ice_servers)
        || value.ice_servers.length < 1
        || value.ice_servers.length > 8
        || !value.ice_servers.every(validIceServer)) break;
      return value as unknown as CallRoomIceServersFrame;
    case "roomState": {
      if (!hasExactKeys(value, ["type", "call", "participants"])
        || !validCall(value.call)
        || !Array.isArray(value.participants)
        || value.participants.length !== 2
        || !value.participants.every(validParticipant)) break;
      return value as unknown as CallRoomStateFrame;
    }
    case "answer":
      if (!hasExactKeys(value, ["type", "session_description"])
        || !validDescription(value.session_description, "answer")) break;
      return value as unknown as CallRoomServerAnswerFrame;
    case "offer":
      if (!hasExactKeys(value, ["type", "session_description", "track"])
        || (value.track !== "audio" && value.track !== "video")
        || !validDescription(value.session_description, "offer")) break;
      return value as unknown as CallRoomSubscriptionOfferFrame;
    case "ended":
      if (!hasExactKeys(value, ["type", "reason"])
        || !TERMINAL_STATUSES.has(value.reason as CallTerminalStatus)) break;
      return value as unknown as CallRoomEndedFrame;
    case "error":
      if (!hasExactKeys(value, ["type", "code", "message"])
        || !ROOM_ERROR_CODES.has(value.code as CallRoomErrorCode)
        || typeof value.message !== "string") break;
      return value as unknown as CallRoomErrorFrame;
    default:
      break;
  }
  throw new Error("Relay Call room received an invalid frame.");
};

const text = async (value: unknown): Promise<string> => {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.text();
  throw new Error("Relay Call room received a non-text frame.");
};

const reasonText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
};

/**
 * Authenticated JSON signaling socket for one Relay Call participant.
 *
 * The room reopens its socket after any close that neither this client nor the
 * server asked for, with PartySocket's numbers (PROTOCOL.md section 5): first
 * retry after 3000 ms, then x1.3, capped at 10000 ms, a 4000 ms connect
 * timeout, the retry count reset once a socket stays open 5000 ms, and no
 * retry limit. On every open it sends `join`, then `userUpdate` with the last
 * muted/video state, then the frames queued while closed. Media is never
 * re-offered by a socket-only reconnect.
 */
export class CallRoom {
  readonly callID: string;
  readonly url: string;
  state: CallRoomStateFrame | null = null;
  /**
   * The STUN/TURN servers from the room's latest `iceServers` frame, or `null`
   * before the first one. Relay sends fresh ones on every join, reconnects
   * included, so read this again before building each new peer connection.
   */
  iceServers: CallRoomIceServer[] | null = null;

  readonly #apiKey: string;
  readonly #WebSocket: WebSocketConstructor;
  readonly #heartbeatIntervalMs: number;
  readonly #onWarning: (message: string) => void;
  /** Unknown server frame types already warned about, so each is logged once. */
  readonly #unknownFrameTypes = new Set<string>();
  readonly #signal: AbortSignal | undefined;
  readonly #listeners = new Map<CallRoomEvent, Set<(...args: any[]) => void>>();
  /** The open socket, or the still-open socket a manual `reconnect()` is replacing. */
  #socket: WebSocketLike | undefined;
  /** The socket being opened, not yet accepted. */
  #attempt: { socket: WebSocketLike; detach: () => void } | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #uptimeTimer: ReturnType<typeof setTimeout> | undefined;
  /** PartySocket `_retryCount`: -1 before the first connect, 0 once a socket stayed up. */
  #retryCount = -1;
  #closed = false;
  #ended = false;
  #connectionState: CallRoomConnectionState = "idle";
  #queue: string[] = [];
  #muted: boolean | undefined;
  #video: boolean | undefined;
  #openWaiters: OpenWaiter[] = [];
  /** The pending manual `reconnect()`, rejected alone when its attempt fails and the old socket is kept. */
  #manual: OpenWaiter | undefined;

  constructor(callID: string, baseURL: string, apiKey: string, options: CallRoomOptions = {}) {
    this.callID = callID;
    this.#apiKey = apiKey;
    this.#WebSocket = options.WebSocket ?? (NodeWebSocket as unknown as WebSocketConstructor);
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#onWarning = options.onWarning ?? ((message) => console.warn(message));
    this.#signal = options.signal;
    if (!Number.isFinite(this.#heartbeatIntervalMs) || this.#heartbeatIntervalMs <= 0) {
      throw new Error("Call room heartbeatIntervalMs must be greater than zero.");
    }
    const url = new URL(baseURL.replace(/\/+$/u, ""));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/v1/calls/${encodeURIComponent(callID)}/room`;
    url.search = "";
    url.hash = "";
    this.url = url.toString();
    if (this.#signal) {
      if (this.#signal.aborted) this.#closed = true;
      else this.#signal.addEventListener("abort", () => this.close(1000, "Aborted"), { once: true });
    }
  }

  /** `reconnecting` while the room waits to reopen a dropped socket. */
  get connectionState(): CallRoomConnectionState {
    return this.#connectionState;
  }

  on<K extends CallRoomEvent>(event: K, listener: Listener<K>): this {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener as (...args: any[]) => void);
    return this;
  }

  off<K extends CallRoomEvent>(event: K, listener: Listener<K>): this {
    this.#listeners.get(event)?.delete(listener as (...args: any[]) => void);
    return this;
  }

  /** Resolves on the first open; a failed attempt is retried, not thrown. */
  async connect(): Promise<void> {
    if (this.#closed) throw new Error("Relay Call room is closed.");
    if (this.#connectionState === "open") return;
    if (this.#connectionState === "connecting") {
      throw new Error("Relay Call room is already connecting.");
    }
    const opened = this.#waitForOpen();
    if (this.#connectionState === "idle") {
      this.#ended = false;
      this.#retryCount = -1;
      this.#connect();
    }
    return opened;
  }

  /**
   * Open a new signaling socket now, keeping application/WebRTC state alive.
   * Relay accepts the new authenticated socket before the previous one closes,
   * so an active Call is not interpreted as having lost its participant. Same
   * path as the automatic reconnect (PartySocket `reconnect()`: retry count
   * reset, no delay); if the new socket fails while the old one is still open,
   * the old one stays and this rejects.
   */
  async reconnect(): Promise<void> {
    if (this.#closed) throw new Error("Relay Call room is closed.");
    let manual!: OpenWaiter;
    const opened = new Promise<void>((resolve, reject) => { manual = { resolve, reject }; });
    this.#openWaiters.push(manual);
    this.#manual = manual;
    this.#ended = false;
    this.#retryCount = -1;
    this.#clearRetryTimer();
    this.#abandonAttempt();
    this.#connect();
    try {
      await opened;
    } finally {
      if (this.#manual === manual) this.#manual = undefined;
    }
  }

  /**
   * Send one frame. While the socket is reopening the frame is queued and sent
   * after `join` on the next open (PartySocket's queue); heartbeats are dropped.
   */
  send(frame: CallRoomClientFrame): void {
    if (this.#closed || this.#connectionState === "idle" || this.#connectionState === "closed") {
      throw new Error("Relay Call room is not connected.");
    }
    if (frame.type === "userUpdate") {
      this.#muted = frame.muted;
      if (frame.video !== undefined) this.#video = frame.video;
    }
    const data = JSON.stringify(frame);
    if (this.#connectionState === "open" && this.#socket) {
      this.#socket.send(data);
      return;
    }
    // `userUpdate` is re-sent from the recorded state on open, not queued.
    if (frame.type === "heartbeat" || frame.type === "userUpdate") return;
    this.#queue.push(data);
  }

  connected(): void {
    this.send({ type: "connected" });
  }

  userUpdate(update: { muted: boolean; video?: boolean }): void {
    this.send({
      type: "userUpdate",
      muted: update.muted,
      ...(update.video === undefined ? {} : { video: update.video }),
    });
  }

  end(): void {
    this.send({ type: "end" });
  }

  close(code = 1000, reason = "Client closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connectionState = "closed";
    this.#stopHeartbeat();
    this.#clearRetryTimer();
    this.#clearUptimeTimer();
    this.#abandonAttempt();
    this.#queue = [];
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(code, reason);
    this.#rejectOpenWaiters(new Error("Relay Call room is closed."));
  }

  #waitForOpen(): Promise<void> {
    return new Promise((resolve, reject) => this.#openWaiters.push({ resolve, reject }));
  }

  #rejectOpenWaiters(error: Error): void {
    const waiters = this.#openWaiters;
    this.#openWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  /** PartySocket `_getNextDelay`. */
  #nextDelay(): number {
    if (this.#retryCount <= 0) return 0;
    return Math.min(
      MIN_RECONNECTION_DELAY_MS * RECONNECTION_DELAY_GROW_FACTOR ** (this.#retryCount - 1),
      MAX_RECONNECTION_DELAY_MS,
    );
  }

  /** PartySocket `_connect`: count the attempt, wait the delay, open. */
  #connect(cause: { close?: CallRoomCloseEvent; error?: Error } = {}): void {
    if (this.#closed) return;
    this.#retryCount += 1;
    const delayMs = this.#nextDelay();
    if (!this.#socket) this.#connectionState = this.#retryCount === 0 ? "connecting" : "reconnecting";
    else this.#connectionState = "connecting";
    if (delayMs === 0) {
      this.#open();
      return;
    }
    this.#emit("reconnecting", { attempt: this.#retryCount, delayMs, ...cause });
    if (this.#closed) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#open();
    }, delayMs);
  }

  #open(): void {
    if (this.#closed) return;
    const socket = new this.#WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.#apiKey}` },
    });
    let settled = false;
    const timeout = setTimeout(() => fail(new Error("Relay Call room connect timed out.")), CONNECTION_TIMEOUT_MS);
    const detach = (): void => {
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      detach();
      this.#attempt = undefined;
      socket.addEventListener("error", ignore);
      try { socket.close(1000, "timeout"); } catch { /* the socket may not be closable yet */ }
      if (this.#closed) return;
      const previous = this.#socket;
      const manual = this.#manual;
      if (previous && manual) {
        // The socket a manual reconnect was replacing is still open: keep it.
        this.#connectionState = "open";
        this.#flush(previous);
        this.#manual = undefined;
        this.#openWaiters = this.#openWaiters.filter((waiter) => waiter !== manual);
        manual.reject(error);
        return;
      }
      this.#connect({ error });
    };
    const onError = (): void => fail(new Error("Relay Call room WebSocket failed to connect."));
    const onClose = (event: any): void => fail(new Error(
      `Relay Call room closed before connecting (${Number(event?.code ?? 1006)}).`,
    ));
    const onOpen = (): void => {
      if (settled) return;
      detach();
      this.#attempt = undefined;
      if (this.#closed) {
        socket.close(1000, "Client closed");
        return;
      }
      const previous = this.#socket;
      this.#socket = socket;
      this.#connectionState = "open";
      this.#attachOpenSocket(socket);
      this.#clearUptimeTimer();
      this.#uptimeTimer = setTimeout(() => {
        this.#uptimeTimer = undefined;
        this.#retryCount = 0;
      }, MIN_UPTIME_MS);
      this.#uptimeTimer.unref?.();
      socket.send(JSON.stringify({ type: "join" } satisfies CallRoomClientFrame));
      if (this.#muted !== undefined) {
        socket.send(JSON.stringify({
          type: "userUpdate",
          muted: this.#muted,
          ...(this.#video === undefined ? {} : { video: this.#video }),
        } satisfies CallRoomClientFrame));
      }
      this.#flush(socket);
      this.#startHeartbeat();
      if (previous && previous !== socket) previous.close(1000, "Replaced");
      const waiters = this.#openWaiters;
      this.#openWaiters = [];
      for (const waiter of waiters) waiter.resolve();
      this.#emit("open");
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    this.#attempt = { socket, detach };
  }

  #flush(socket: WebSocketLike): void {
    const queue = this.#queue;
    this.#queue = [];
    for (const data of queue) socket.send(data);
  }

  #abandonAttempt(): void {
    const attempt = this.#attempt;
    if (!attempt) return;
    this.#attempt = undefined;
    attempt.detach();
    attempt.socket.addEventListener("error", ignore);
    try { attempt.socket.close(1000, "Client closed"); } catch { /* not closable yet */ }
  }

  /** A close the client or the server asked for, or the Call is over: never reopen. */
  #isFinal(event: CallRoomCloseEvent): boolean {
    if (this.#closed || this.#ended) return true;
    if (event.code === CLIENT_PROTOCOL_ERROR) return true;
    if (event.code === 1000 && (event.reason === "Replaced" || event.reason === "Call ended")) return true;
    const status = this.state?.call.status;
    return status !== undefined && TERMINAL_STATUSES.has(status as CallTerminalStatus);
  }

  #attachOpenSocket(socket: WebSocketLike): void {
    socket.addEventListener("message", (event: any) => {
      void this.#message(socket, event?.data).catch((error: unknown) => {
        if (socket !== this.#socket) return;
        const parsed = error instanceof Error ? error : new Error(String(error));
        this.#emit("error", parsed);
        socket.close(CLIENT_PROTOCOL_ERROR, "invalid frame");
      });
    });
    // A socket error is always followed by its close; the close decides.
    socket.addEventListener("error", ignore);
    socket.addEventListener("close", (event: any) => {
      if (socket !== this.#socket) return;
      this.#stopHeartbeat();
      this.#clearUptimeTimer();
      this.#socket = undefined;
      const close: CallRoomCloseEvent = {
        code: Number(event?.code ?? 1006),
        reason: reasonText(event?.reason),
        wasClean: Boolean(event?.wasClean),
      };
      // A manual reconnect's new socket is still opening: the server closes
      // the socket it replaces ("Replaced"), and the new socket decides.
      if (this.#attempt) {
        this.#connectionState = "connecting";
        return;
      }
      if (!this.#isFinal(close)) {
        this.#connect({ close });
        return;
      }
      this.#clearRetryTimer();
      this.#abandonAttempt();
      this.#queue = [];
      if (!this.#closed) this.#connectionState = "idle";
      this.#rejectOpenWaiters(new Error(`Relay Call room closed (${close.code}).`));
      this.#emit("close", close);
    });
  }

  async #message(socket: WebSocketLike, data: unknown): Promise<void> {
    if (socket !== this.#socket) return;
    const source = await text(data);
    const value: unknown = JSON.parse(source);
    if (isRecord(value) && typeof value.type === "string" && !KNOWN_SERVER_FRAME_TYPES.has(value.type)) {
      if (!this.#unknownFrameTypes.has(value.type)) {
        this.#unknownFrameTypes.add(value.type);
        try {
          this.#onWarning(`Relay Call room ignored a server frame of unknown type "${value.type}".`);
        } catch { /* a warning sink never corrupts signaling */ }
      }
      return;
    }
    const frame = parseCallRoomServerFrame(value);
    if (!frame) return;
    switch (frame.type) {
      case "iceServers":
        this.iceServers = frame.ice_servers;
        this.#emit("iceServers", frame);
        return;
      case "roomState":
        this.state = frame;
        this.#emit("roomState", frame);
        return;
      case "offer":
        this.#emit("offer", frame);
        return;
      case "answer":
        this.#emit("answer", frame);
        return;
      case "ended":
        this.#ended = true;
        this.#emit("ended", frame);
        return;
      case "error":
        this.#emit("error", frame);
        return;
    }
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeat = setInterval(() => {
      if (this.#connectionState !== "open" || !this.#socket) return;
      this.#socket.send(JSON.stringify({ type: "heartbeat" } satisfies CallRoomClientFrame));
    }, this.#heartbeatIntervalMs);
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat(): void {
    if (!this.#heartbeat) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  #clearRetryTimer(): void {
    if (!this.#retryTimer) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  #clearUptimeTimer(): void {
    if (!this.#uptimeTimer) return;
    clearTimeout(this.#uptimeTimer);
    this.#uptimeTimer = undefined;
  }

  #emit<K extends CallRoomEvent>(event: K, ...args: CallRoomEventMap[K]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try { listener(...args); } catch { /* listener failures never corrupt signaling */ }
    }
  }
}

/** Absorbs late errors from sockets the room no longer listens to (PartySocket `absorbError`). */
const ignore = (): void => {};

interface OpenWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}
