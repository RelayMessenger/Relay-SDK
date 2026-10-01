/**
 * Rive in a Relay Call: the agent drives a Rive file the phone draws, through
 * data binding (View Model Instance values and triggers), timed against the
 * agent's own audio, and hears the values and triggers the phone writes back.
 *
 * Every wire name lives in this one block so a rename touches one place.
 */
export const RIVE_CHANNEL = "rive";
/** A message is at most 1 KB of UTF-8 JSON. */
export const RIVE_MESSAGE_MAX_BYTES = 1024;
/**
 * The channel is unordered and lossy, as Cloudflare's docs advise for
 * replaceable state (realtime/sfu/datachannels.mdx, "Configure message
 * delivery"): each message overwrites what it sets, so a lost one is
 * corrected by the next.
 */
export const RIVE_CHANNEL_OPTIONS = Object.freeze({ ordered: false, maxRetransmits: 0 });

/** A View Model property value: number, boolean, string, enum (string) or color (number). */
export type RiveValue = number | boolean | string;

/**
 * One message on the `rive` channel, either way. `t` is milliseconds of the
 * agent's own audio (its audio RTP timestamp / 48); the phone applies the
 * message when that audio plays, and at once without `t`. `view_model` maps
 * View Model Instance property paths (`"score/value"`) to values; `trigger`
 * fires one trigger property; `file`, `artboard` and `state_machine` switch
 * what is shown (the file must be Relay-hosted).
 */
export interface RiveMessage {
  t?: number;
  view_model?: Record<string, RiveValue>;
  trigger?: string;
  file?: string;
  artboard?: string;
  state_machine?: string;
}

export interface RiveTiming {
  /**
   * When the phone applies it, in milliseconds of the agent's audio track:
   * read `transport.audioTimeMs()` just before `writeAudio` and add the offset
   * inside that audio. Omit to apply at once.
   */
  at?: number;
}

/** What to show: a Relay-hosted `.riv`, optionally its artboard and state machine, and starting values. */
export interface RiveScene {
  file: string;
  artboard?: string;
  state_machine?: string;
  view_model?: Record<string, RiveValue>;
}

export type RiveEventMap = {
  /** The phone wrote View Model values back (the person changed something in the scene). */
  view_model: [Record<string, RiveValue>];
  /** The phone fired a trigger property. */
  trigger: [string];
};

const encoder = new TextEncoder();

const isRiveValue = (value: unknown): value is RiveValue =>
  typeof value === "boolean"
  || typeof value === "string"
  || (typeof value === "number" && Number.isFinite(value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const validValues = (values: unknown): values is Record<string, RiveValue> =>
  isRecord(values)
  && Object.keys(values).length > 0
  && Object.entries(values).every(([name, value]) => name.length > 0 && isRiveValue(value));

/** Serialize one message, or throw when it is malformed or over 1 KB. */
export const encodeRiveMessage = (message: RiveMessage): string => {
  const out: RiveMessage = {};
  if (message.t !== undefined) {
    if (!Number.isFinite(message.t) || message.t < 0) {
      throw new RangeError("Rive `at` must be a finite number of milliseconds, at least 0.");
    }
    out.t = Math.round(message.t);
  }
  for (const key of ["file", "artboard", "state_machine"] as const) {
    const value = message[key];
    if (value === undefined) continue;
    if (!nonEmpty(value)) throw new RangeError(`Rive \`${key}\` must be a non-empty string.`);
    out[key] = value;
  }
  if ((out.artboard !== undefined || out.state_machine !== undefined) && out.file === undefined) {
    throw new RangeError("Rive `artboard` and `state_machine` come with a `file`.");
  }
  if (message.view_model !== undefined) {
    if (!validValues(message.view_model)) {
      throw new TypeError("Rive `view_model` maps property names to finite numbers, booleans or strings.");
    }
    out.view_model = { ...message.view_model };
  }
  if (message.trigger !== undefined) {
    if (!nonEmpty(message.trigger)) throw new RangeError("Rive `trigger` needs a trigger name.");
    out.trigger = message.trigger;
  }
  if (out.view_model === undefined && out.trigger === undefined && out.file === undefined) {
    throw new RangeError("A Rive message sets values, fires a trigger or shows a file.");
  }
  const text = JSON.stringify(out);
  if (encoder.encode(text).byteLength > RIVE_MESSAGE_MAX_BYTES) {
    throw new RangeError(`A Rive message is at most ${RIVE_MESSAGE_MAX_BYTES} bytes of JSON.`);
  }
  return text;
};

/** Read one message from the phone; null for anything malformed. Unknown keys are ignored. */
export const parseRiveMessage = (data: unknown): RiveMessage | null => {
  const text = typeof data === "string"
    ? data
    : data instanceof Uint8Array ? new TextDecoder().decode(data) : undefined;
  if (text === undefined || encoder.encode(text).byteLength > RIVE_MESSAGE_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const message: RiveMessage = {};
  if (value.view_model !== undefined) {
    if (!validValues(value.view_model)) return null;
    message.view_model = value.view_model;
  }
  if (value.trigger !== undefined) {
    if (!nonEmpty(value.trigger)) return null;
    message.trigger = value.trigger;
  }
  return message.view_model || message.trigger ? message : null;
};

/** @internal What the transport hands the handle: send now, or report that no channel is open. */
export interface RiveSink {
  send(text: string): boolean;
}

type Listener<K extends keyof RiveEventMap> = (...args: RiveEventMap[K]) => void;

/**
 * The agent's handle on its `rive` channel, from `transport.rive()`. Sends
 * are fire-and-forget and return false when the channel is down (during a
 * restart). When it reopens, the last `show` and the latest value of every
 * property are sent again, untimed.
 */
export class RelayRive {
  readonly #sink: RiveSink;
  #scene: Omit<RiveScene, "view_model"> | undefined;
  /** The latest value of every property set, replayed when the channel reopens. */
  readonly #values = new Map<string, RiveValue>();
  readonly #listeners = new Map<keyof RiveEventMap, Set<(...args: any[]) => void>>();

  /** @internal */
  constructor(sink: RiveSink) {
    this.#sink = sink;
  }

  /** Set View Model Instance properties, such as `{ viseme: 3, speaking: true }`. */
  set(values: Record<string, RiveValue>, timing: RiveTiming = {}): boolean {
    const text = encodeRiveMessage({ ...at(timing), view_model: values });
    for (const [name, value] of Object.entries(values)) this.#values.set(name, value);
    return this.#sink.send(text);
  }

  /** Fire one trigger property, such as `"nod"`. */
  trigger(name: string, timing: RiveTiming = {}): boolean {
    return this.#sink.send(encodeRiveMessage({ ...at(timing), trigger: name }));
  }

  /** Switch to another Relay-hosted file, artboard or state machine, with optional starting values. */
  show(scene: RiveScene, timing: RiveTiming = {}): boolean {
    const text = encodeRiveMessage({ ...at(timing), ...scene });
    this.#scene = {
      file: scene.file,
      ...(scene.artboard === undefined ? {} : { artboard: scene.artboard }),
      ...(scene.state_machine === undefined ? {} : { state_machine: scene.state_machine }),
    };
    this.#values.clear();
    for (const [name, value] of Object.entries(scene.view_model ?? {})) this.#values.set(name, value);
    return this.#sink.send(text);
  }

  on<K extends keyof RiveEventMap>(event: K, listener: Listener<K>): this {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener as (...args: any[]) => void);
    return this;
  }

  off<K extends keyof RiveEventMap>(event: K, listener: Listener<K>): this {
    this.#listeners.get(event)?.delete(listener as (...args: any[]) => void);
    return this;
  }

  /** @internal One message from the phone. */
  _receive(data: unknown): void {
    const message = parseRiveMessage(data);
    if (!message) return;
    if (message.view_model) this.#emit("view_model", message.view_model);
    if (message.trigger) this.#emit("trigger", message.trigger);
  }

  /** @internal The scene and latest values as untimed messages of at most 1 KB each. */
  _replay(): string[] {
    const messages: string[] = [];
    if (this.#scene) messages.push(encodeRiveMessage(this.#scene));
    let batch: Record<string, RiveValue> = {};
    for (const [name, value] of this.#values) {
      const next = { ...batch, [name]: value };
      try {
        encodeRiveMessage({ view_model: next });
        batch = next;
      } catch {
        messages.push(encodeRiveMessage({ view_model: batch }));
        batch = { [name]: value };
      }
    }
    if (Object.keys(batch).length) messages.push(encodeRiveMessage({ view_model: batch }));
    return messages;
  }

  #emit<K extends keyof RiveEventMap>(event: K, ...args: RiveEventMap[K]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try { listener(...args); } catch { /* listeners own their failures */ }
    }
  }
}

const at = (timing: RiveTiming): { t?: number } => (timing.at === undefined ? {} : { t: timing.at });
