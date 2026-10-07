import type Relay from "@relaymessenger/sdk";
import type { CallRoom, CallRoomOptions } from "@relaymessenger/sdk";
import {
  RelayCallTransport,
  visemesFromAlignment,
  type CharacterAlignment,
  type RelayAudioFrame,
  type RelayIceServer,
  type RelayIceServersProvider,
  type RelayRive,
  type RelayWebRTCFactory,
} from "@relaymessenger/sdk/calls";
import { isRelayToolName, runRelayTool } from "./tools.js";

/** ElevenLabs' API origin; the Agents WebSocket lives under the same host as `wss://`. */
export const ELEVENLABS_API = "https://api.elevenlabs.io";

/** The PCM formats both sides can carry without resampling (ElevenLabs `pcm_<rate>`). */
const INBOUND_RATES = new Set([8_000, 16_000, 24_000, 48_000]);

/** The minimal WHATWG WebSocket the bridge drives; Node 22's global `WebSocket` is one. */
export interface ElevenLabsSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type ElevenLabsSocketConstructor = new (url: string) => ElevenLabsSocket;

/** One server event from the ElevenLabs Agents WebSocket (`type` plus its `<type>_event` body). */
export interface ElevenLabsEvent {
  type: string;
  [key: string]: unknown;
}

export interface SignedUrlOptions {
  apiKey: string;
  agentId: string;
  /** Defaults to `https://api.elevenlabs.io`; use a residency origin such as `https://api.eu.residency.elevenlabs.io`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Cancels the request. */
  signal?: AbortSignal;
}

/**
 * A signed Agents WebSocket URL for a private agent, from your server with your
 * API key: `GET /v1/convai/conversation/get-signed-url?agent_id=…` with
 * `xi-api-key` (ElevenLabs, "Agent WebSockets", Using a signed URL).
 */
export const getSignedUrl = async (options: SignedUrlOptions): Promise<string> => {
  const url = new URL("/v1/convai/conversation/get-signed-url", options.baseUrl ?? ELEVENLABS_API);
  url.searchParams.set("agent_id", options.agentId);
  const response = await (options.fetch ?? fetch)(url, {
    headers: { "xi-api-key": options.apiKey },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs refused a signed URL for agent ${options.agentId} (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as { signed_url?: unknown };
  if (typeof body.signed_url !== "string" || !body.signed_url.startsWith("wss://")) {
    throw new Error("ElevenLabs returned no signed_url.");
  }
  return body.signed_url;
};

export interface ElevenLabsRiveOptions {
  /** View Model number driven with Preston Blair's ten mouths from the audio's alignment. Default `"viseme"`; null leaves it alone. */
  viseme?: string | null;
  /** View Model boolean true while the agent's audio plays. Default `"speaking"`; null leaves it alone. */
  speaking?: string | null;
}

export interface ElevenLabsCallOptions {
  relay: Relay;
  /** The Call from `call.created`; joining its room answers it. */
  callId: string;
  elevenlabs: {
    agentId: string;
    /** Your ElevenLabs API key, to mint a signed URL; omit for a public agent or when you pass `signedUrl`. */
    apiKey?: string;
    /** A signed URL you minted yourself (`getSignedUrl`). */
    signedUrl?: string;
    /** Defaults to `https://api.elevenlabs.io`. */
    baseUrl?: string;
    /** Sent as `conversation_initiation_client_data` (overrides, dynamic variables); `type` is added. */
    initiationData?: Record<string, unknown>;
  };
  /**
   * The caller's audio rate sent to ElevenLabs: the agent's
   * `user_input_audio_format`. Default 16000 (`pcm_16000`, ElevenLabs' default).
   */
  inputSampleRate?: 8_000 | 16_000 | 24_000 | 48_000;
  /** Drive the agent's Rive file from the audio's alignment. Default on; false turns it off. */
  rive?: ElevenLabsRiveOptions | false;
  /**
   * Answer the agent's Relay client tools (`relayClientTools`: send_message,
   * send_buttons, send_selection, send_place, request_location, read_location,
   * send_link) in the Call's chat. `chatId` skips looking the chat up from the
   * Call. Other client tools still reach only `onEvent`.
   */
  relayTools?: true | { chatId?: string };
  /** Every ElevenLabs server event, after the bridge handled it (transcripts, agent responses, tool calls). */
  onEvent?: (event: ElevenLabsEvent) => void;
  onWarning?: (message: string) => void;
  room?: CallRoomOptions;
  iceServers?: RelayIceServer[] | RelayIceServersProvider;
  /** @internal */
  roomClient?: CallRoom;
  /** @internal */
  webRTC?: RelayWebRTCFactory;
  /** @internal Defaults to the global `WebSocket`. */
  WebSocket?: ElevenLabsSocketConstructor;
  /** @internal */
  fetch?: typeof fetch;
}

const OPEN = 1;

const decodePcm = (base64: string): Int16Array => {
  const bytes = Buffer.from(base64, "base64");
  // A Buffer from base64 may start at an odd offset; copy so the view is aligned.
  const samples = new Int16Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2);
  return samples;
};

const encodePcm = (samples: Int16Array): string =>
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");

const pcmRate = (format: unknown): number | undefined => {
  const match = typeof format === "string" ? /^pcm_(\d+)$/u.exec(format) : null;
  return match ? Number(match[1]) : undefined;
};

/** How far ahead of the audio being sent a Rive change goes out; later ones wait, so an interruption can drop them. */
export const RIVE_LEAD_MS = 300;
/** Caller audio kept while the ElevenLabs session starts, at most. */
const STARTUP_AUDIO_MS = 2_000;
/** A partial 10 ms slice left at the end of an audio event is padded and sent after this much quiet. */
const CARRY_FLUSH_MS = 100;
/** Missing end markers: allow this much quiet after the queued audio plays out. */
const REPLY_QUIET_MS = 250;
/** When ElevenLabs closes the session, its queued last words get this long past their own length to play out. */
const CLOSE_PLAYOUT_GRACE_MS = 2_000;

type RiveValues = Record<string, number | boolean>;

/**
 * An ElevenLabs Agent on a Relay Call. It copies ElevenLabs' own LiveKit
 * bridge (docs "LiveKit integration", bridge.mts): join the call (`connect`
 * resolves once media is up), open the Agents WebSocket with a signed URL,
 * send `conversation_initiation_client_data`, stream the caller's PCM as
 * `user_audio_chunk`, play each `audio` event, clear queued audio on
 * `interruption`, and answer every `ping` with a `pong`. Audio from a reply the
 * caller interrupted is dropped by `event_id`, as ElevenLabs' Python SDK does.
 * Each `audio` event's alignment also becomes `viseme` values on the agent's
 * Rive file, timed against where that audio really starts on the agent's
 * track, and sent shortly before it plays.
 */
export class ElevenLabsCall {
  readonly transport: RelayCallTransport;
  /** ElevenLabs' id for the session, once `conversation_initiation_metadata` arrives. */
  conversationId: string | undefined;
  /** The call's Rive channel, once open; undefined while it opens, when it failed, or with `rive: false`. */
  rive: RelayRive | undefined;
  /** Resolves when the bridge is done: the call ended, ElevenLabs closed, or `close()`. */
  readonly closed: Promise<void>;

  readonly #socket: ElevenLabsSocket;
  readonly #options: ElevenLabsCallOptions;
  readonly #riveOptions: { viseme: string | null; speaking: string | null } | undefined;
  #outputRate: number | undefined;
  #lastInterruptId = 0;
  #speaking = false;
  #ready = false;
  #done = false;
  #resolveClosed!: () => void;
  /** Bumped on every interruption: audio and changes from before it are dropped. */
  #generation = 0;
  /** Samples short of one 10 ms slice, carried into the next audio event so no gap is padded in. */
  #carry = new Int16Array(0);
  #carryTimer: NodeJS.Timeout | undefined;
  #replyTimer: NodeJS.Timeout | undefined;
  /** New audio invalidates an older completion callback, even within the same reply. */
  #audioRevision = 0;
  #lastAudioId = 0;
  #lastWrite: Promise<void> = Promise.resolve();
  /** Where the last written agent audio ends on the track. */
  #endMs: number | undefined;
  /** Rive changes waiting until their audio is close to playing, in time order. */
  readonly #cues: Array<{ at: number; values: RiveValues }> = [];
  #cueTimer: NodeJS.Timeout | undefined;
  /** The caller's audio from before the ElevenLabs session was ready. */
  readonly #startupAudio: RelayAudioFrame[] = [];
  #startupAudioMs = 0;
  #failStart: ((error: Error) => void) | undefined;
  #chatId: Promise<string> | undefined;
  readonly #onAudio = (frame: RelayAudioFrame): void => this.#sendAudio(frame);
  readonly #onEnded = (): void => this.#stop(new Error("The Relay Call ended before the ElevenLabs session started."), false);
  readonly #onClose = (): void => this.#stop(new Error("The Relay Call room closed before the ElevenLabs session started."), false);

  private constructor(transport: RelayCallTransport, socket: ElevenLabsSocket, options: ElevenLabsCallOptions) {
    this.transport = transport;
    this.#socket = socket;
    this.#options = options;
    this.#riveOptions = options.rive === false
      ? undefined
      : {
        viseme: options.rive?.viseme === undefined ? "viseme" : options.rive.viseme,
        speaking: options.rive?.speaking === undefined ? "speaking" : options.rive.speaking,
      };
    this.closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
  }

  /** Join the call, then open the ElevenLabs session; resolves once both are up. */
  static async connect(options: ElevenLabsCallOptions): Promise<ElevenLabsCall> {
    const inputSampleRate = options.inputSampleRate ?? 16_000;
    if (!INBOUND_RATES.has(inputSampleRate)) throw new RangeError("inputSampleRate must be 8000, 16000, 24000 or 48000.");
    const transport = new RelayCallTransport({
      relay: options.relay,
      callId: options.callId,
      inboundAudio: { sampleRate: inputSampleRate, channelCount: 1 },
      ...(options.room ? { room: options.room } : {}),
      ...(options.roomClient ? { roomClient: options.roomClient } : {}),
      ...(options.webRTC ? { webRTC: options.webRTC } : {}),
      ...(options.iceServers ? { iceServers: options.iceServers } : {}),
      ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    });
    // Listen from the start: the caller may speak, hang up or be replaced while ElevenLabs starts.
    const early: RelayAudioFrame[] = [];
    let ended = false;
    const endedError = (): Error => new Error("The Relay Call ended before the ElevenLabs session started.");
    // A hangup settles connect at once, even while a request hangs, and cancels that request.
    const abort = new AbortController();
    let rejectEnded!: (error: Error) => void;
    const whenEnded = new Promise<never>((_resolve, reject) => { rejectEnded = reject; });
    whenEnded.catch(() => undefined);
    const untilEnded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, whenEnded]);
    const keep = (frame: RelayAudioFrame): void => { early.push(frame); };
    const end = (): void => {
      if (ended) return;
      ended = true;
      abort.abort(endedError());
      rejectEnded(endedError());
    };
    transport.on("audio", keep).on("ended", end).on("close", end);
    let socket: ElevenLabsSocket | undefined;
    try {
      await untilEnded(transport.connect());
      const url = options.elevenlabs.signedUrl
        ?? (options.elevenlabs.apiKey
          ? await untilEnded(getSignedUrl({
            apiKey: options.elevenlabs.apiKey,
            agentId: options.elevenlabs.agentId,
            ...(options.elevenlabs.baseUrl ? { baseUrl: options.elevenlabs.baseUrl } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
            signal: abort.signal,
          }))
          : publicAgentUrl(options.elevenlabs.agentId, options.elevenlabs.baseUrl));
      if (ended) throw endedError();
      const Socket = options.WebSocket ?? (globalThis.WebSocket as unknown as ElevenLabsSocketConstructor);
      socket = new Socket(url);
      const call = new ElevenLabsCall(transport, socket, options);
      transport.off("audio", keep).off("ended", end).off("close", end);
      for (const frame of early) call.#sendAudio(frame);
      await call.#start(inputSampleRate);
      return call;
    } catch (error) {
      transport.off("audio", keep).off("ended", end).off("close", end);
      try { socket?.close(); } catch { /* already closed */ }
      transport.close();
      throw error;
    }
  }

  /** End the Relay Call for both sides; the bridge then closes. */
  end(): void {
    this.transport.end();
  }

  /** Close the ElevenLabs session and leave the call without ending it. */
  close(): void {
    this.#finish(false);
  }

  async #start(inputSampleRate: number): Promise<void> {
    const socket = this.#socket;
    this.transport.on("audio", this.#onAudio).on("ended", this.#onEnded).on("close", this.#onClose);
    await new Promise<void>((resolve, reject) => {
      this.#failStart = reject;
      socket.onopen = () => {
        socket.send(JSON.stringify({ ...this.#options.elevenlabs.initiationData, type: "conversation_initiation_client_data" }));
      };
      socket.onerror = () => {
        if (!this.#ready) this.#stop(new Error("The ElevenLabs Agents WebSocket failed to open."), false);
      };
      socket.onclose = (event) => {
        if (!this.#ready) this.#stop(new Error(`ElevenLabs closed the session before it started (${event.code ?? "no code"}).`), false);
        else void this.#finishAfterPlayout();
      };
      socket.onmessage = (event) => {
        const message = parse(event.data);
        if (!message) return;
        if (!this.#ready && message.type === "conversation_initiation_metadata") {
          const body = message.conversation_initiation_metadata_event as Record<string, unknown> | undefined;
          const input = pcmRate(body?.user_input_audio_format);
          const output = pcmRate(body?.agent_output_audio_format);
          if (input !== inputSampleRate) {
            this.#stop(new Error(
              `The ElevenLabs agent takes ${String(body?.user_input_audio_format)}; pass inputSampleRate to match it, or set the agent to pcm_${inputSampleRate}.`,
            ), false);
            return;
          }
          // RelayCallTransport takes any rate that is a multiple of 100 Hz (10 ms slices): not 22050, not ulaw.
          if (output === undefined || output % 100 !== 0) {
            this.#stop(new Error(
              `The ElevenLabs agent speaks ${String(body?.agent_output_audio_format)}; set its output to pcm_16000, pcm_24000, pcm_44100 or pcm_48000.`,
            ), false);
            return;
          }
          this.#ready = true;
          this.#failStart = undefined;
          this.#outputRate = output;
          this.conversationId = typeof body?.conversation_id === "string" ? body.conversation_id : undefined;
          // The caller's words from while the session started go first.
          for (const frame of this.#startupAudio.splice(0)) this.#send({ user_audio_chunk: encodePcm(frame.samples) });
          this.#startupAudioMs = 0;
          resolve();
          if (this.#riveOptions) void this.#openRive();
        }
        if (this.#ready) this.#handle(message);
      };
    });
  }

  async #openRive(): Promise<void> {
    try {
      this.rive = await this.transport.rive();
      this.#pumpCues();
    } catch (error) {
      this.#cues.length = 0;
      this.#options.onWarning?.(`The Rive channel did not open, so the call has no mouth shapes: ${(error as Error).message}`);
    }
  }

  #handle(message: ElevenLabsEvent): void {
    switch (message.type) {
      case "audio":
        this.#playAudio(message.audio_event as AudioEvent | undefined);
        break;
      case "agent_response_complete": {
        // Agents WebSocket reference: response/correction events are text, not
        // audio EOF. agent_response_complete is the generation-end notification.
        // https://elevenlabs.io/docs/agents-platform/api-reference/agents-platform/websocket
        const id = Number((message.agent_response_complete_event as { event_id?: unknown } | undefined)?.event_id);
        if (Number.isFinite(id) && id > this.#lastInterruptId && id >= this.#lastAudioId) void this.#endReply();
        break;
      }
      case "interruption": {
        const id = Number((message.interruption_event as { event_id?: unknown } | undefined)?.event_id);
        if (Number.isFinite(id)) this.#lastInterruptId = Math.max(this.#lastInterruptId, id);
        this.#interrupt();
        break;
      }
      case "client_tool_call":
        this.#runTool(message.client_tool_call as ClientToolCall | undefined);
        break;
      case "ping": {
        const ping = message.ping_event as { event_id?: unknown } | undefined;
        this.#send({ type: "pong", event_id: ping?.event_id });
        break;
      }
      default:
        break;
    }
    try {
      this.#options.onEvent?.(message);
    } catch { /* the application owns its listener */ }
  }

  /** A Relay tool the agent called: run it in the Call's chat and answer with `client_tool_result`. */
  #runTool(call: ClientToolCall | undefined): void {
    const tools = this.#options.relayTools;
    if (!tools || !call || !isRelayToolName(call.tool_name) || typeof call.tool_call_id !== "string") return;
    const id = call.tool_call_id;
    const name = call.tool_name;
    const args = call.parameters !== null && typeof call.parameters === "object" && !Array.isArray(call.parameters)
      ? call.parameters as Record<string, unknown>
      : {};
    const reply = call.expects_response !== false;
    void (async () => {
      try {
        const result = await runRelayTool(this.#options.relay, await this.#chat(tools), name, args);
        if (reply) this.#send({ type: "client_tool_result", tool_call_id: id, result, is_error: false });
      } catch (error) {
        this.#options.onWarning?.(`Relay tool ${name} failed: ${(error as Error).message}`);
        if (reply) this.#send({ type: "client_tool_result", tool_call_id: id, result: (error as Error).message, is_error: true });
      }
    })();
  }

  #chat(tools: true | { chatId?: string }): Promise<string> {
    if (tools !== true && tools.chatId) return Promise.resolve(tools.chatId);
    this.#chatId ??= this.#options.relay.calls.retrieve(this.#options.callId).then((response) => response.call.chat_id);
    // A failed lookup is retried on the next tool call.
    this.#chatId.catch(() => { this.#chatId = undefined; });
    return this.#chatId;
  }

  /** The caller talked over the agent: drop what has not played (bridge.mts `source.clearQueue()`) and every change not yet sent. */
  #interrupt(): void {
    this.#generation += 1;
    this.#audioRevision += 1;
    this.#carry = new Int16Array(0);
    clearTimeout(this.#carryTimer);
    clearTimeout(this.#replyTimer);
    this.transport.clearAudio();
    this.#cues.length = 0;
    this.#endMs = undefined;
    this.#speaking = false;
    const values = this.#restValues();
    if (this.rive && Object.keys(values).length) this.rive.set(values);
  }

  #restValues(): RiveValues {
    const names = this.#riveOptions;
    const values: RiveValues = {};
    if (names?.viseme) values[names.viseme] = 0;
    if (names?.speaking) values[names.speaking] = false;
    return values;
  }

  #playAudio(event: AudioEvent | undefined): void {
    if (!event || this.#outputRate === undefined) return;
    // Audio from a reply the caller already interrupted is stale (ElevenLabs Python SDK).
    if (Number(event.event_id) <= this.#lastInterruptId) return;
    const revision = ++this.#audioRevision;
    const id = Number(event.event_id);
    if (Number.isFinite(id)) this.#lastAudioId = id;
    clearTimeout(this.#replyTimer);
    const rate = this.#outputRate;
    const fresh = typeof event.audio_base_64 === "string" ? decodePcm(event.audio_base_64) : new Int16Array(0);
    const final = event.is_final === true;
    // Whole 10 ms slices only, so the transport never pads a gap between events; the remainder waits.
    const slice = rate / 100;
    const carried = this.#carry.length;
    const all = new Int16Array(carried + fresh.length);
    all.set(this.#carry);
    all.set(fresh, carried);
    const whole = final ? all.length : all.length - (all.length % slice);
    this.#carry = all.slice(whole);
    clearTimeout(this.#carryTimer);
    if (this.#carry.length) {
      this.#carryTimer = setTimeout(() => { void this.#flushCarry(); }, CARRY_FLUSH_MS);
      this.#carryTimer.unref?.();
    }
    const generation = this.#generation;
    const names = this.#riveOptions;
    const durationMs = (fresh.length / rate) * 1_000;
    const cue = (startMs: number): void => {
      if (this.#done || generation !== this.#generation) return;
      // Where this event's own audio starts: after the samples carried from the last one.
      const at = startMs + (carried / rate) * 1_000;
      if (names?.speaking && !this.#speaking) this.#queueCue(at, { [names.speaking]: true });
      this.#speaking = true;
      if (names?.viseme && event.alignment) {
        try {
          for (const shape of visemesFromAlignment(event.alignment, { endWithRest: false })) {
            if (shape.t <= durationMs) this.#queueCue(at + shape.t, { [names.viseme]: shape.viseme });
          }
        } catch (error) {
          this.#options.onWarning?.(`ElevenLabs alignment was not usable: ${(error as Error).message}`);
        }
      }
      this.#endMs = at + durationMs;
    };
    let written = this.#lastWrite;
    if (whole === 0) {
      if (this.#endMs !== undefined) cue(this.#endMs - (carried / rate) * 1_000);
    } else {
      // writeAudio resolves with where this audio really starts on the track, held audio included.
      written = this.transport
        .writeAudio({ samples: all.subarray(0, whole), sampleRate: rate, channelCount: 1 })
        .then((startMs) => { if (startMs !== undefined) cue(startMs); })
        .catch((error: unknown) => this.#options.onWarning?.(`Relay refused ElevenLabs audio: ${(error as Error).message}`));
    }
    this.#lastWrite = written;
    void written.then(() => {
      if (this.#done || revision !== this.#audioRevision) return;
      if (final) void this.#endReply();
      else {
        this.#replyTimer = setTimeout(() => { void this.#endReply(); }, this.transport.queuedAudioMs() + REPLY_QUIET_MS);
        this.#replyTimer.unref?.();
      }
    });
  }

  #flushCarry(): Promise<void> {
    if (!this.#carry.length || this.#outputRate === undefined) return this.#lastWrite;
    const samples = this.#carry;
    this.#carry = new Int16Array(0);
    const rate = this.#outputRate;
    const generation = this.#generation;
    this.#lastWrite = this.transport.writeAudio({ samples, sampleRate: rate, channelCount: 1 }).then((startMs) => {
      if (this.#done || generation !== this.#generation || startMs === undefined) return;
      const speaking = this.#riveOptions?.speaking;
      if (speaking && !this.#speaking) this.#queueCue(startMs, { [speaking]: true });
      this.#speaking = true;
      this.#endMs = startMs + samples.length / rate * 1_000;
    }).catch((error: unknown) => this.#options.onWarning?.(`Relay refused ElevenLabs audio: ${(error as Error).message}`));
    return this.#lastWrite;
  }

  async #endReply(): Promise<void> {
    const revision = this.#audioRevision;
    clearTimeout(this.#replyTimer);
    clearTimeout(this.#carryTimer);
    await this.#lastWrite;
    if (this.#done || revision !== this.#audioRevision) return;
    await this.#flushCarry();
    if (this.#done || revision !== this.#audioRevision) return;
    clearTimeout(this.#replyTimer);
    // waitForPlayout calls the engine's waitForDrain, which pads a partial
    // 20 ms Opus packet with silence. Writing 10 ms slices alone cannot flush it.
    await this.transport.waitForPlayout();
    if (this.#done || revision !== this.#audioRevision) return;
    this.#speaking = false;
    const rest = this.#restValues();
    if (this.#endMs !== undefined && Object.keys(rest).length) {
      // A partial Opus packet may have waited through the quiet timeout. Its
      // original write time is then in the past; rest only after it was sent.
      this.#queueCue(Math.max(this.#endMs, this.transport.audioTimeMs()), rest);
    }
    this.#endMs = undefined;
  }

  #queueCue(at: number, values: RiveValues): void {
    let index = this.#cues.length;
    while (index > 0 && this.#cues[index - 1]!.at > at) index -= 1;
    this.#cues.splice(index, 0, { at, values });
    this.#pumpCues();
  }

  /** Sends every change whose audio is within RIVE_LEAD_MS of being sent; the rest wait so an interruption can drop them. */
  #pumpCues(): void {
    clearTimeout(this.#cueTimer);
    this.#cueTimer = undefined;
    const rive = this.rive;
    if (!rive || this.#done || !this.#cues.length) return;
    let sentMs: number;
    try {
      sentMs = this.transport.audioTimeMs() - this.transport.queuedAudioMs();
    } catch {
      return;
    }
    while (this.#cues.length && this.#cues[0]!.at <= sentMs + RIVE_LEAD_MS) {
      const next = this.#cues.shift()!;
      rive.set(next.values, { at: next.at });
    }
    if (this.#cues.length) {
      this.#cueTimer = setTimeout(() => this.#pumpCues(), Math.max(10, Math.min(100, this.#cues[0]!.at - sentMs - RIVE_LEAD_MS)));
      this.#cueTimer.unref?.();
    }
  }

  #sendAudio(frame: RelayAudioFrame): void {
    if (!this.#ready) {
      // Bounded: the newest STARTUP_AUDIO_MS of the caller's audio waits for the session.
      this.#startupAudio.push(frame);
      this.#startupAudioMs += (frame.samples.length / frame.channelCount / frame.sampleRate) * 1_000;
      while (this.#startupAudioMs > STARTUP_AUDIO_MS && this.#startupAudio.length > 1) {
        const dropped = this.#startupAudio.shift()!;
        this.#startupAudioMs -= (dropped.samples.length / dropped.channelCount / dropped.sampleRate) * 1_000;
      }
      return;
    }
    this.#send({ user_audio_chunk: encodePcm(frame.samples) });
  }

  #send(message: Record<string, unknown>): void {
    if (this.#done || this.#socket.readyState !== OPEN) return;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch { /* the close handler finishes the bridge */ }
  }

  /** Before the session is ready: fail `connect`; after: finish. */
  #stop(error: Error, endCall: boolean): void {
    const fail = this.#failStart;
    if (fail) {
      this.#failStart = undefined;
      this.#finish(false);
      fail(error);
      return;
    }
    if (this.#ready) this.#finish(endCall);
  }

  /**
   * ElevenLabs closed the session: its last words may still be queued on the
   * track. Play them out, then end the Relay Call. A hangup, an interruption
   * or `close()` meanwhile finishes at once instead.
   */
  async #finishAfterPlayout(): Promise<void> {
    if (this.#done) return;
    const revision = this.#audioRevision;
    try {
      await this.#lastWrite;
      await this.#flushCarry();
      if (!this.#done && revision === this.#audioRevision) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          this.transport.waitForPlayout(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.transport.queuedAudioMs() + CLOSE_PLAYOUT_GRACE_MS);
            timer.unref?.();
          }),
        ]).finally(() => clearTimeout(timer));
      }
    } catch { /* the call is ending either way */ }
    this.#finish(true);
  }

  /** `endCall`: ElevenLabs ended the session, so the Relay Call ends too. */
  #finish(endCall: boolean): void {
    if (this.#done) return;
    this.#done = true;
    clearTimeout(this.#carryTimer);
    clearTimeout(this.#replyTimer);
    clearTimeout(this.#cueTimer);
    this.#cues.length = 0;
    this.transport.off("audio", this.#onAudio).off("ended", this.#onEnded).off("close", this.#onClose);
    try { this.#socket.close(); } catch { /* already closed */ }
    if (endCall) {
      try { this.transport.end(); } catch { /* the room is gone */ }
    }
    this.transport.close();
    this.#resolveClosed();
  }
}

interface ClientToolCall {
  tool_name?: unknown;
  tool_call_id?: unknown;
  parameters?: unknown;
  expects_response?: unknown;
}

interface AudioEvent {
  audio_base_64?: unknown;
  event_id?: unknown;
  alignment?: CharacterAlignment;
  is_final?: unknown;
}

const parse = (data: unknown): ElevenLabsEvent | undefined => {
  const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : undefined;
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
      ? (value as ElevenLabsEvent)
      : undefined;
  } catch {
    return undefined;
  }
};

/** A public agent connects with its id alone (ElevenLabs, "Agent WebSockets"). */
const publicAgentUrl = (agentId: string, baseUrl = ELEVENLABS_API): string => {
  const url = new URL("/v1/convai/conversation", baseUrl.replace(/^http/u, "ws"));
  url.searchParams.set("agent_id", agentId);
  return url.toString();
};
