import NodeWebSocket from "ws";
import { RelayAPIError } from "./errors.js";
import type {
  Call,
  CallRoomAnswerFrame,
  CallRoomClientFrame,
  CallRoomEndedFrame,
  CallRoomErrorFrame,
  CallRoomMedia,
  CallRoomOfferFrame,
  CallRoomParticipant,
  CallRoomServerFrame,
  CallRoomStateFrame,
} from "./types.js";
import type { WebSocketConstructor, WebSocketLike } from "./websocket.js";

export interface CallRoomOptions {
  WebSocket?: WebSocketConstructor;
  /** Clients send `heartbeat` every 15 s (the room's hibernation auto-response). */
  heartbeatIntervalMs?: number;
}

export interface CallRoomEvents {
  roomState: (frame: CallRoomStateFrame) => void;
  offer: (frame: CallRoomOfferFrame) => void;
  answer: (frame: CallRoomAnswerFrame) => void;
  ended: (frame: CallRoomEndedFrame) => void;
  /** A server `error` frame, an upgrade failure, or an invalid frame (closed 4400). */
  error: (error: CallRoomErrorFrame | Error) => void;
  close: (event: { code: number; reason: string }) => void;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
/** The exact text frame the room answers from the runtime, never by code. */
const HEARTBEAT_FRAME = JSON.stringify({ type: "heartbeat" });
const CLIENT_CLOSE_INVALID_FRAME = 4400;

const CALL_STATUSES = new Set(["ringing", "connecting", "active", "ended"]);
const END_REASONS = new Set([
  "completed", "declined", "canceled", "no_answer", "disconnected", "failed",
]);
const ROOM_ERROR_CODES = new Set(["invalid_frame", "not_allowed", "media_unavailable"]);
const TRACKS = new Set(["microphone", "agent-voice"]);

interface UpgradeResponseLike {
  statusCode?: number;
  statusMessage?: string;
  setEncoding?(encoding: string): void;
  on(type: string, listener: (...args: any[]) => void): unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};

const isSessionDescription = (value: unknown, type: "offer" | "answer"): boolean =>
  isRecord(value)
  && hasKeys(value, ["type", "sdp"])
  && value.type === type
  && typeof value.sdp === "string"
  && value.sdp.length > 0;

const isCall = (value: unknown): value is Call =>
  isRecord(value)
  && typeof value.id === "string"
  && typeof value.chat_id === "string"
  && isRecord(value.from)
  && Array.isArray(value.to)
  && value.mode === "audio"
  && CALL_STATUSES.has(String(value.status))
  && Number.isInteger(value.revision)
  && typeof value.created_at === "string"
  && (value.end_reason === null || END_REASONS.has(String(value.end_reason)));

const isParticipant = (value: unknown): value is CallRoomParticipant =>
  isRecord(value)
  && hasKeys(value, ["contact_id", "kind", "attached", "track", "muted", "connected"])
  && typeof value.contact_id === "string"
  && (value.kind === "user" || value.kind === "agent")
  && typeof value.attached === "boolean"
  && (value.track === null || TRACKS.has(String(value.track)))
  && typeof value.muted === "boolean"
  && typeof value.connected === "boolean";

const isMedia = (value: unknown): value is CallRoomMedia =>
  isRecord(value)
  && hasKeys(value, ["url", "token", "expires_at", "audio_format"])
  && typeof value.url === "string"
  && typeof value.token === "string"
  && typeof value.expires_at === "string"
  && isRecord(value.audio_format)
  && value.audio_format.encoding === "pcm_s16le"
  && value.audio_format.sample_rate === 48_000
  && value.audio_format.channels === 2;

const parseServerFrame = (value: unknown): CallRoomServerFrame | undefined => {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "roomState":
      return hasKeys(value, ["type", "call", "participants"], ["media"])
        && isCall(value.call)
        && Array.isArray(value.participants)
        && value.participants.every(isParticipant)
        && (!Object.hasOwn(value, "media") || isMedia(value.media))
        ? value as unknown as CallRoomStateFrame
        : undefined;
    case "answer":
      return hasKeys(value, ["type", "session_description"])
        && isSessionDescription(value.session_description, "answer")
        ? value as unknown as CallRoomAnswerFrame
        : undefined;
    case "offer":
      return hasKeys(value, ["type", "session_description", "track"])
        && isSessionDescription(value.session_description, "offer")
        && TRACKS.has(String(value.track))
        ? value as unknown as CallRoomOfferFrame
        : undefined;
    case "ended":
      return hasKeys(value, ["type", "reason"]) && END_REASONS.has(String(value.reason))
        ? value as unknown as CallRoomEndedFrame
        : undefined;
    case "error":
      return hasKeys(value, ["type", "code", "message"])
        && ROOM_ERROR_CODES.has(String(value.code))
        && typeof value.message === "string"
        ? value as unknown as CallRoomErrorFrame
        : undefined;
    case "heartbeat":
      return hasKeys(value, ["type"]) ? { type: "heartbeat" } : undefined;
    default:
      return undefined;
  }
};

const deriveRoomURL = (baseURL: string, callID: string): string => {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new TypeError("Relay baseURL must be an absolute HTTP(S) URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new TypeError("Relay baseURL must be an absolute HTTP(S) URL.");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/v1/calls/${encodeURIComponent(callID)}/room`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

/**
 * One participant's socket to a Call room. Opens `GET /v1/calls/{callId}/room`
 * with the same bearer as every REST route, sends `join`, and keeps `state`
 * at the latest `roomState` the room pushed. Nothing is polled.
 */
export class CallRoom {
  readonly url: string;
  /** The latest `roomState` frame, or null before the room has answered `join`. */
  state: CallRoomStateFrame | null = null;
  readonly #socket: WebSocketLike;
  readonly #listeners = new Map<keyof CallRoomEvents, Set<(...args: any[]) => void>>();
  readonly #heartbeatIntervalMs: number;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #open = false;
  #closed = false;

  constructor(
    baseURL: string,
    callID: string,
    token: string,
    options: CallRoomOptions = {},
  ) {
    if (!callID.trim()) throw new TypeError("A Call id is required to join its room.");
    if (!token.trim()) throw new TypeError("A Relay token is required to join a Call room.");
    this.url = deriveRoomURL(baseURL, callID);
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    const Constructor = options.WebSocket
      ?? (NodeWebSocket as unknown as WebSocketConstructor);
    this.#socket = new Constructor(this.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    this.#socket.addEventListener("open", this.#onOpen);
    this.#socket.addEventListener("message", this.#onMessage);
    this.#socket.addEventListener("close", this.#onClose);
    this.#socket.addEventListener("error", this.#onError);
    this.#socket.on?.("unexpected-response", this.#onUnexpectedResponse);
  }

  get closed(): boolean {
    return this.#closed;
  }

  on<K extends keyof CallRoomEvents>(event: K, listener: CallRoomEvents[K]): this {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  off<K extends keyof CallRoomEvents>(event: K, listener: CallRoomEvents[K]): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  /** Send one client frame from the room contract. */
  send(frame: CallRoomClientFrame): void {
    if (this.#closed) throw new Error("Relay Call room socket is closed.");
    this.#socket.send(JSON.stringify(frame));
  }

  /** Callee only: ringing → connecting. */
  accept(): void {
    this.send({ type: "accept" });
  }

  /** Callee only: ringing → ended(declined). */
  decline(): void {
    this.send({ type: "decline" });
  }

  /** Either side: ringing → ended(canceled) by the caller, else ended(completed). */
  end(): void {
    this.send({ type: "end" });
  }

  /** "My remote track is playing"; the second side's `connected` makes the Call active. */
  connected(): void {
    this.send({ type: "connected" });
  }

  /** Mute state for the other side's screen; the room answers with `roomState`. */
  userUpdate(update: { muted: boolean }): void {
    this.send({ type: "userUpdate", muted: update.muted });
  }

  close(code = 1000, reason = "client closed"): void {
    if (this.#closed) return;
    this.#stopHeartbeat();
    try {
      this.#socket.close(code, reason);
    } catch {
      this.#finish({ code, reason });
    }
  }

  #emit<K extends keyof CallRoomEvents>(
    event: K,
    ...args: Parameters<CallRoomEvents[K]>
  ): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  #finish(event: { code: number; reason: string }): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopHeartbeat();
    this.#socket.removeEventListener("open", this.#onOpen);
    this.#socket.removeEventListener("message", this.#onMessage);
    this.#socket.removeEventListener("close", this.#onClose);
    this.#socket.removeEventListener("error", this.#onError);
    this.#socket.off?.("unexpected-response", this.#onUnexpectedResponse);
    this.#emit("close", event);
  }

  #invalid(message: string): void {
    this.#emit("error", new Error(`Relay Call room received an invalid frame: ${message}`));
    this.close(CLIENT_CLOSE_INVALID_FRAME, "invalid frame");
  }

  readonly #onOpen = (): void => {
    if (this.#open || this.#closed) return;
    this.#open = true;
    this.send({ type: "join" });
    this.#heartbeat = setInterval(() => {
      try {
        this.#socket.send(HEARTBEAT_FRAME);
      } catch (cause) {
        this.#emit("error", cause instanceof Error ? cause : new Error(String(cause)));
        this.close(1000, "heartbeat failed");
      }
    }, this.#heartbeatIntervalMs);
  };

  readonly #onMessage = (message: { data: unknown }): void => {
    if (this.#closed) return;
    let value: unknown;
    try {
      const data = message.data;
      const textData = typeof data === "string"
        ? data
        : data instanceof ArrayBuffer || ArrayBuffer.isView(data)
          ? new TextDecoder().decode(data)
          : undefined;
      if (textData === undefined) {
        this.#invalid("non-text frame");
        return;
      }
      value = JSON.parse(textData);
    } catch {
      this.#invalid("invalid JSON");
      return;
    }
    const frame = parseServerFrame(value);
    if (frame === undefined) {
      this.#invalid(isRecord(value) && typeof value.type === "string"
        ? `unexpected ${value.type} frame`
        : "missing type");
      return;
    }
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
        // The room closes 1000 "Call ended" right after; closing here too
        // is idempotent and frees the timer without waiting for it.
        this.close(1000, "Call ended");
        return;
      case "error":
        this.#emit("error", frame);
        return;
      case "heartbeat":
        return;
    }
  };

  readonly #onClose = (event: { code?: number; reason?: string }): void => {
    this.#finish({ code: event.code ?? 1006, reason: event.reason ?? "" });
  };

  readonly #onError = (): void => {
    if (this.#closed) return;
    this.#emit("error", new Error("Relay Call room connection failed."));
  };

  readonly #onUnexpectedResponse = (
    _request: unknown,
    response: UpgradeResponseLike,
  ): void => {
    const chunks: string[] = [];
    response.setEncoding?.("utf8");
    response.on("data", (chunk: unknown) => {
      if (chunks.join("").length < 65_536) chunks.push(String(chunk));
    });
    const settle = (): void => {
      const status = response.statusCode ?? 0;
      let message = `Relay Call room upgrade failed with HTTP ${status}.`;
      let body: unknown = chunks.join("");
      try {
        body = JSON.parse(chunks.join("")) as unknown;
        if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
          message = body.error.message;
        }
      } catch {
        // Keep the unparsed body for diagnostics.
      }
      this.#emit("error", new RelayAPIError(message, { status, body }));
      this.#finish({ code: 1006, reason: `HTTP ${status}` });
    };
    response.on("end", settle);
    response.on("error", settle);
  };
}
