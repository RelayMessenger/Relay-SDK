import { AudioOutput, type AgentSession } from "@livekit/agents";
import type { RelayRive as RelayRiveChannel } from "@relaymessenger/sdk/calls";
import type { RelayLiveKitCall } from "./livekit.js";

export interface RelayRiveOptions {
  /** View Model boolean set true while a reply's audio plays. Null leaves it alone. Default `"speaking"`. */
  speakingProperty?: string | null;
  /** View Model number reset to 0 (rest) when a reply ends. Null leaves it alone. Default `"viseme"`. */
  visemeProperty?: string | null;
}

/**
 * Drive the agent's Rive file from a LiveKit Agents session on a Relay Call,
 * in the shape of LiveKit's avatar plugins (`new AvatarSession().start(session,
 * room)`, docs.livekit.io agents/models/avatar) with the Relay call in place of
 * the room: the phone draws the agent's own Rive file instead of a provider's
 * video. Each reply sets `speaking` true at the audio time its first sample
 * plays and false, with `viseme` 0, when it finishes or is interrupted.
 *
 * Word-timed visemes need the session's transcription output, whose
 * `TextOutput` class `@livekit/agents` 1.9 does not export, so they are left
 * to `rive` (`visemesFromAlignment` with your TTS's timings) or to the
 * Python `RelayRive`, which reads TTS-aligned words.
 */
export class RelayRive {
  readonly #speaking: string | null;
  readonly #viseme: string | null;
  #call: RelayLiveKitCall | undefined;
  /** The call's Rive channel once `start` resolves: `set`, `trigger`, `show`, and the phone's events. */
  rive: RelayRiveChannel | undefined;

  constructor(options: RelayRiveOptions = {}) {
    this.#speaking = options.speakingProperty === undefined ? "speaking" : options.speakingProperty;
    this.#viseme = options.visemeProperty === undefined ? "viseme" : options.visemeProperty;
  }

  async start(_agentSession: Pick<AgentSession, "output">, room: RelayLiveKitCall): Promise<void> {
    this.#call = room;
    this.rive = await room.transport.rive();
    room.output.on(AudioOutput.EVENT_PLAYBACK_STARTED, this.#started);
    room.output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, this.#finished);
  }

  readonly #started = (): void => {
    if (!this.rive || !this.#speaking || !this.#call) return;
    const at = this.#call.output.segmentStartMs;
    this.rive.set({ [this.#speaking]: true }, at === undefined ? {} : { at });
  };

  readonly #finished = (event: { playbackPosition: number; interrupted: boolean }): void => {
    if (!this.rive || !this.#call) return;
    const values: Record<string, boolean | number> = {};
    if (this.#speaking) values[this.#speaking] = false;
    if (this.#viseme) values[this.#viseme] = 0;
    if (!Object.keys(values).length) return;
    const start = this.#call.output.segmentStartMs;
    // A finished reply rests where its audio ends, after its last timed change; an interrupted one at once.
    const at = event.interrupted || start === undefined ? undefined : start + event.playbackPosition * 1_000;
    this.rive.set(values, at === undefined ? {} : { at });
  };
}
