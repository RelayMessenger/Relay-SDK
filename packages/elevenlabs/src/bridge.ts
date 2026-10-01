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
}

/**
 * A signed Agents WebSocket URL for a private agent, from your server with your
 * API key: `GET /v1/convai/conversation/get-signed-url?agent_id=…` with
 * `xi-api-key` (ElevenLabs, "Agent WebSockets", Using a signed URL).
 */
export const getSignedUrl = async (options: SignedUrlOptions): Promise<string> => {
  const url = new URL("/v1/convai/conversation/get-signed-url", options.baseUrl ?? ELEVENLABS_API);
  url.searchParams.set("agent_id", options.agentId);
  const response = await (options.fetch ?? fetch)(url, { headers: { "xi-api-key": options.apiKey } });
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

/**
 * An ElevenLabs Agent on a Relay Call. It copies ElevenLabs' own LiveKit
 * bridge (docs "LiveKit integration", bridge.mts): join the call (`connect`
 * resolves once media is up), open the Agents WebSocket with a signed URL,
 * send `conversation_initiation_client_data`, stream the caller's PCM as
 * `user_audio_chunk`, play each `audio` event, clear queued audio on
 * `interruption`, and answer every `ping` with a `pong`. Audio from a reply the
 * caller interrupted is dropped by `event_id`, as ElevenLabs' Python SDK does.
 * Each `audio` event's alignment also becomes `viseme` values on the agent's
 * Rive file, timed against the agent's audio track.
 */
export class ElevenLabsCall {
  readonly transport: RelayCallTransport;
  /** The ElevenLabs conversation, once `conversation_initiation_metadata` arrives. */
  conversationId: string | undefined;
  /** The call's Rive channel, once open (when `rive` is not false). */
  rive: RelayRive | undefined;
  /** Resolves when the bridge is done: the call ended, ElevenLabs closed, or `close()`. */
  readonly closed: Promise<void>;

  readonly #socket: ElevenLabsSocket;
  readonly #options: ElevenLabsCallOptions;
  readonly #riveOptions: { viseme: string | null; speaking: string | null } | undefined;
  #outputRate: number | undefined;
  #lastInterruptId = 0;
  #speaking = false;
  #done = false;
  #resolveClosed!: () => void;
  readonly #onAudio = (frame: RelayAudioFrame): void => this.#sendAudio(frame);

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

  /** Join the call, then open the ElevenLabs conversation; resolves once both are up. */
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
    try {
      await transport.connect();
      const url = options.elevenlabs.signedUrl
        ?? (options.elevenlabs.apiKey
          ? await getSignedUrl({
            apiKey: options.elevenlabs.apiKey,
            agentId: options.elevenlabs.agentId,
            ...(options.elevenlabs.baseUrl ? { baseUrl: options.elevenlabs.baseUrl } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
          })
          : publicAgentUrl(options.elevenlabs.agentId, options.elevenlabs.baseUrl));
      const Socket = options.WebSocket ?? (globalThis.WebSocket as unknown as ElevenLabsSocketConstructor);
      const socket = new Socket(url);
      const call = new ElevenLabsCall(transport, socket, options);
      await call.#start(inputSampleRate);
      return call;
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  /** End the Relay Call for both sides; the bridge then closes. */
  end(): void {
    this.transport.end();
  }

  /** Close the ElevenLabs conversation and leave the call without ending it. */
  close(): void {
    this.#finish(false);
  }

  async #start(inputSampleRate: number): Promise<void> {
    const socket = this.#socket;
    await new Promise<void>((resolve, reject) => {
      let metadata = false;
      socket.onopen = () => {
        socket.send(JSON.stringify({ ...this.#options.elevenlabs.initiationData, type: "conversation_initiation_client_data" }));
      };
      socket.onerror = () => {
        if (!metadata) reject(new Error("The ElevenLabs Agents WebSocket failed to open."));
      };
      socket.onclose = (event) => {
        if (!metadata) reject(new Error(`ElevenLabs closed the conversation before it started (${event.code ?? "no code"}).`));
        else this.#finish(true);
      };
      socket.onmessage = (event) => {
        const message = parse(event.data);
        if (!message) return;
        if (!metadata && message.type === "conversation_initiation_metadata") {
          const body = message.conversation_initiation_metadata_event as Record<string, unknown> | undefined;
          const input = pcmRate(body?.user_input_audio_format);
          const output = pcmRate(body?.agent_output_audio_format);
          if (input !== inputSampleRate) {
            reject(new Error(
              `The ElevenLabs agent takes ${String(body?.user_input_audio_format)}; pass inputSampleRate to match it, or set the agent to pcm_${inputSampleRate}.`,
            ));
            socket.close();
            return;
          }
          // RelayCallTransport takes any rate that is a multiple of 100 Hz (10 ms slices): not 22050, not ulaw.
          if (output === undefined || output % 100 !== 0) {
            reject(new Error(
              `The ElevenLabs agent speaks ${String(body?.agent_output_audio_format)}; set its output to pcm_16000, pcm_24000, pcm_44100 or pcm_48000.`,
            ));
            socket.close();
            return;
          }
          metadata = true;
          this.#outputRate = output;
          this.conversationId = typeof body?.conversation_id === "string" ? body.conversation_id : undefined;
          this.transport.on("audio", this.#onAudio);
          this.transport.on("ended", () => this.#finish(false));
          resolve();
          if (this.#riveOptions) void this.#openRive();
        }
        this.#handle(message);
      };
    });
  }

  async #openRive(): Promise<void> {
    try {
      this.rive = await this.transport.rive();
    } catch (error) {
      this.#options.onWarning?.(`The Rive channel did not open, so the call has no mouth shapes: ${(error as Error).message}`);
    }
  }

  #handle(message: ElevenLabsEvent): void {
    switch (message.type) {
      case "audio":
        this.#playAudio(message.audio_event as AudioEvent | undefined);
        break;
      case "interruption": {
        const id = Number((message.interruption_event as { event_id?: unknown } | undefined)?.event_id);
        if (Number.isFinite(id)) this.#lastInterruptId = Math.max(this.#lastInterruptId, id);
        // The caller talked over the agent: drop what has not played (bridge.mts `source.clearQueue()`).
        this.transport.clearAudio();
        this.#stopSpeaking();
        break;
      }
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

  #playAudio(event: AudioEvent | undefined): void {
    if (!event || typeof event.audio_base_64 !== "string" || this.#outputRate === undefined) return;
    // Audio from a reply the caller already interrupted is stale (ElevenLabs Python SDK).
    if (Number(event.event_id) <= this.#lastInterruptId) return;
    const samples = decodePcm(event.audio_base_64);
    if (!samples.length) return;
    let at: number | undefined;
    try {
      at = this.transport.audioTimeMs();
    } catch {
      at = undefined;
    }
    void this.transport
      .writeAudio({ samples, sampleRate: this.#outputRate, channelCount: 1 })
      .catch((error: unknown) => this.#options.onWarning?.(`Relay refused ElevenLabs audio: ${(error as Error).message}`));
    const rive = this.rive;
    const names = this.#riveOptions;
    if (!rive || !names || at === undefined) return;
    if (names.speaking && !this.#speaking) rive.set({ [names.speaking]: true }, { at });
    this.#speaking = true;
    const durationMs = (samples.length / this.#outputRate) * 1_000;
    if (names.viseme && event.alignment) {
      try {
        for (const cue of visemesFromAlignment(event.alignment, { endWithRest: event.is_final === true })) {
          if (cue.t <= durationMs) rive.set({ [names.viseme]: cue.viseme }, { at: at + cue.t });
        }
      } catch (error) {
        this.#options.onWarning?.(`ElevenLabs alignment was not usable: ${(error as Error).message}`);
      }
    }
    if (event.is_final === true) {
      if (names.speaking) rive.set({ [names.speaking]: false }, { at: at + durationMs });
      this.#speaking = false;
    }
  }

  #stopSpeaking(): void {
    const rive = this.rive;
    const names = this.#riveOptions;
    this.#speaking = false;
    if (!rive || !names) return;
    const values: Record<string, number | boolean> = {};
    if (names.viseme) values[names.viseme] = 0;
    if (names.speaking) values[names.speaking] = false;
    if (Object.keys(values).length) rive.set(values);
  }

  #sendAudio(frame: RelayAudioFrame): void {
    this.#send({ user_audio_chunk: encodePcm(frame.samples) });
  }

  #send(message: Record<string, unknown>): void {
    if (this.#done || this.#socket.readyState !== OPEN) return;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch { /* the close handler finishes the bridge */ }
  }

  /** `endCall`: ElevenLabs ended the conversation, so the Relay Call ends too. */
  #finish(endCall: boolean): void {
    if (this.#done) return;
    this.#done = true;
    this.transport.off("audio", this.#onAudio);
    try { this.#socket.close(); } catch { /* already closed */ }
    if (endCall) {
      try { this.transport.end(); } catch { /* the room is gone */ }
    }
    this.transport.close();
    this.#resolveClosed();
  }
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
