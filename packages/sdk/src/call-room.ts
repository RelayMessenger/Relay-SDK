import NodeWebSocket from "ws";
import type {
  Call,
  CallRoomClientFrame,
  CallRoomEndedFrame,
  CallRoomErrorCode,
  CallRoomErrorFrame,
  CallRoomParticipant,
  CallRoomServerAnswerFrame,
  CallRoomServerFrame,
  CallRoomStateFrame,
  CallRoomSubscriptionOfferFrame,
  CallTerminalStatus,
} from "./types.js";
import type { WebSocketConstructor, WebSocketLike } from "./websocket.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const CLIENT_PROTOCOL_ERROR = 4400;
const TERMINAL_STATUSES = new Set<CallTerminalStatus>([
  "completed", "no-answer", "canceled", "busy", "failed",
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
}

export interface CallRoomCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export type CallRoomEventMap = {
  open: [];
  roomState: [CallRoomStateFrame];
  offer: [CallRoomSubscriptionOfferFrame];
  answer: [CallRoomServerAnswerFrame];
  ended: [CallRoomEndedFrame];
  error: [CallRoomErrorFrame | Error];
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

const validTracks = (value: unknown): boolean =>
  Array.isArray(value)
  && value.length >= 1
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

/**
 * Validate one server frame before exposing it to application code. Relay's
 * runtime may echo the exact heartbeat frame without waking the Call room; that
 * transport heartbeat is intentionally ignored and is not part of the public
 * server-frame union.
 */
export const parseCallRoomServerFrame = (value: unknown): CallRoomServerFrame | null => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Relay Call room received an invalid frame.");
  }
  switch (value.type) {
    case "heartbeat":
      if (!hasExactKeys(value, ["type"])) break;
      return null;
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

/** Authenticated JSON signaling socket for one Relay Call participant. */
export class CallRoom {
  readonly callID: string;
  readonly url: string;
  state: CallRoomStateFrame | null = null;

  readonly #apiKey: string;
  readonly #WebSocket: WebSocketConstructor;
  readonly #heartbeatIntervalMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #listeners = new Map<CallRoomEvent, Set<(...args: any[]) => void>>();
  #socket: WebSocketLike | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #connectionState: "idle" | "connecting" | "open" | "closed" = "idle";

  constructor(callID: string, baseURL: string, apiKey: string, options: CallRoomOptions = {}) {
    this.callID = callID;
    this.#apiKey = apiKey;
    this.#WebSocket = options.WebSocket ?? (NodeWebSocket as unknown as WebSocketConstructor);
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
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

  get connectionState(): "idle" | "connecting" | "open" | "closed" {
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

  async connect(): Promise<void> {
    if (this.#closed) throw new Error("Relay Call room is closed.");
    if (this.#connectionState === "open") return;
    if (this.#connectionState === "connecting") {
      throw new Error("Relay Call room is already connecting.");
    }
    await this.#openSocket(undefined);
  }

  /**
   * Replace the signaling socket while keeping application/WebRTC state alive.
   * Relay accepts the new authenticated socket before the previous one closes,
   * so an active Call is not interpreted as having lost its participant.
   */
  async reconnect(): Promise<void> {
    if (this.#closed) throw new Error("Relay Call room is closed.");
    const previous = this.#socket;
    await this.#openSocket(previous);
  }

  send(frame: CallRoomClientFrame): void {
    if (this.#connectionState !== "open" || !this.#socket) {
      throw new Error("Relay Call room is not connected.");
    }
    this.#socket.send(JSON.stringify(frame));
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
    this.#socket?.close(code, reason);
    this.#socket = undefined;
  }

  async #openSocket(previous: WebSocketLike | undefined): Promise<void> {
    this.#connectionState = "connecting";
    const socket = new this.#WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.#apiKey}` },
    });
    this.#socket = socket;

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      let settled = false;
      const cleanupBeforeOpen = (): void => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onErrorBeforeOpen);
        socket.removeEventListener("close", onCloseBeforeOpen);
      };
      const failBeforeOpen = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanupBeforeOpen();
        if (this.#socket === socket) this.#socket = previous;
        this.#connectionState = previous ? "open" : "idle";
        reject(error);
      };
      const onErrorBeforeOpen = (): void => {
        if (!opened) failBeforeOpen(new Error("Relay Call room WebSocket failed to connect."));
      };
      const onCloseBeforeOpen = (event: any): void => {
        if (!opened) {
          failBeforeOpen(new Error(
            `Relay Call room closed before connecting (${Number(event?.code ?? 1006)}).`,
          ));
        }
      };
      const onOpen = (): void => {
        opened = true;
        if (settled) return;
        settled = true;
        cleanupBeforeOpen();
        if (this.#closed) {
          socket.close(1000, "Client closed");
          reject(new Error("Relay Call room is closed."));
          return;
        }
        this.#socket = socket;
        this.#connectionState = "open";
        this.#attachOpenSocket(socket);
        this.#startHeartbeat();
        socket.send(JSON.stringify({ type: "join" } satisfies CallRoomClientFrame));
        this.#emit("open");
        if (previous && previous !== socket) previous.close(1000, "Replaced");
        resolve();
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onErrorBeforeOpen);
      socket.addEventListener("close", onCloseBeforeOpen);
    });
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
    socket.addEventListener("error", () => {
      if (socket === this.#socket) {
        this.#emit("error", new Error("Relay Call room WebSocket connection error."));
      }
    });
    socket.addEventListener("close", (event: any) => {
      if (socket !== this.#socket) return;
      this.#stopHeartbeat();
      if (!this.#closed) this.#connectionState = "idle";
      this.#socket = undefined;
      this.#emit("close", {
        code: Number(event?.code ?? 1006),
        reason: reasonText(event?.reason),
        wasClean: Boolean(event?.wasClean),
      });
    });
  }

  async #message(socket: WebSocketLike, data: unknown): Promise<void> {
    if (socket !== this.#socket) return;
    const source = await text(data);
    const frame = parseCallRoomServerFrame(JSON.parse(source));
    if (!frame) return;
    switch (frame.type) {
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

  #emit<K extends CallRoomEvent>(event: K, ...args: CallRoomEventMap[K]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try { listener(...args); } catch { /* listener failures never corrupt signaling */ }
    }
  }
}
