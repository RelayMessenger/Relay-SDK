import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Words for one voice note, or undefined when it could not be heard. */
export type Transcribe = (audio: Buffer, filename: string) => Promise<string | undefined>;

export interface TranscribeCppOptions {
  /** The installed transcribe-cpp package: its directory or its `dist/index.js`. */
  readonly module: string;
  /** A speech model transcribe-cpp loads, such as a Parakeet GGUF. */
  readonly model: string;
  /** Decoder for the note; ffmpeg from PATH by default. */
  readonly ffmpeg?: string;
  readonly threads?: number;
}

const run = (command: string, args: readonly string[]): Promise<Buffer> => new Promise((done, fail) => {
  execFile(command, [...args], { encoding: "buffer", maxBuffer: 256 << 20 }, (error, stdout) => error ? fail(error) : done(stdout));
});

/** 16-bit little-endian mono PCM as the floats a speech model reads. */
export const pcmFloats = (raw: Buffer): Float32Array => {
  const pcm = new Float32Array(raw.length >> 1);
  for (let index = 0; index < pcm.length; index++) pcm[index] = raw.readInt16LE(index * 2) / 32768;
  return pcm;
};

/**
 * A voice note heard on this machine: ffmpeg decodes it to 16 kHz mono and
 * transcribe-cpp runs the model, loaded on the first note and kept. Relay
 * delivers voice notes as `media` parts and does not transcribe them.
 */
export const transcribeCpp = (options: TranscribeCppOptions): Transcribe => {
  let session: Promise<(pcm: Float32Array) => Promise<string>> | undefined;
  const load = () => session ??= (async () => {
    const entry = options.module.endsWith(".js") ? options.module : join(options.module, "dist/index.js");
    const { TranscribeModel } = await import(pathToFileURL(entry).href) as {
      TranscribeModel: { load(model: string): Promise<{ createSession(options: { nThreads: number }): { run(pcm: Float32Array, options: { timestamps: "none" }): Promise<{ text?: unknown }> } }> };
    };
    const loaded = (await TranscribeModel.load(options.model)).createSession({ nThreads: options.threads ?? 1 });
    return async (pcm: Float32Array) => String((await loaded.run(pcm, { timestamps: "none" })).text ?? "").trim();
  })();
  return async (audio, filename) => {
    const dir = await mkdtemp(join(tmpdir(), "relay-voice-"));
    try {
      const file = join(dir, filename.replace(/[^\w.-]/gu, "_") || "voice.m4a");
      await writeFile(file, audio);
      const raw = await run(options.ffmpeg ?? "ffmpeg", ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"]);
      return (await (await load())(pcmFloats(raw))) || undefined;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
};
