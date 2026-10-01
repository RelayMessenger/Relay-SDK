/**
 * The xAI calls this agent makes, on xAI's REST API (https://docs.x.ai):
 * Grok on the Responses API with function tools, Grok Imagine image edits,
 * and Grok Imagine image-to-video. Every picture starts from the reference
 * picture, so the character looks the same in every picture and video.
 */

export const XAI_API = "https://api.x.ai/v1";

export interface XaiOptions {
  apiKey: string;
  fetch?: typeof fetch;
  /** Grok model on the Responses API. */
  model?: string;
  imageModel?: string;
  videoModel?: string;
  /** Milliseconds between video status checks. */
  pollMs?: number;
}

/**
 * One Responses API item: a person's or the agent's message, a function call,
 * a function call's output, or a reasoning item. Grok's output items go back
 * into the next request's `input` unchanged.
 */
export type ResponseItem =
  | { role: "user" | "assistant" | "developer"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string; [key: string]: unknown }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "message"; role: "assistant"; content: { type: string; text?: string }[]; [key: string]: unknown }
  | { type: "reasoning"; [key: string]: unknown };

export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Media {
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4";
  filename: string;
}

export class Xai {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly model: string;
  readonly imageModel: string;
  readonly videoModel: string;
  readonly #pollMs: number;

  constructor(options: XaiOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.model = options.model ?? "grok-4.7";
    this.imageModel = options.imageModel ?? "grok-imagine-image-2.0";
    this.videoModel = options.videoModel ?? "grok-imagine-video-1.5";
    this.#pollMs = options.pollMs ?? 5_000;
  }

  async #call<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${XAI_API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`xAI ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  /**
   * One Grok step (POST /responses). The whole chat goes in `input`, so the
   * agent keeps its own history and stores nothing on xAI.
   */
  async respond(instructions: string, input: ResponseItem[], tools: FunctionTool[]): Promise<ResponseItem[]> {
    const result = await this.#call<{ output: ResponseItem[] }>("/responses", {
      model: this.model,
      instructions,
      input,
      tools,
      store: false,
    });
    return result.output;
  }

  /** A first picture from words alone (POST /images/generations). */
  async generate(prompt: string): Promise<Media> {
    return decoded(await this.#call("/images/generations", {
      model: this.imageModel,
      prompt,
      response_format: "b64_json",
    }));
  }

  /** A new picture of the character in the reference image (POST /images/edits). */
  async picture(reference: Media, prompt: string): Promise<Media> {
    return decoded(await this.#call("/images/edits", {
      model: this.imageModel,
      prompt,
      image: { url: dataUrl(reference), type: "image_url" },
      response_format: "b64_json",
    }));
  }

  /**
   * A short video that starts from `still` (POST /videos/generations, then
   * GET /videos/{request_id} until it is done).
   */
  async video(still: Media, prompt: string, seconds = 6): Promise<Media> {
    const { request_id: id } = await this.#call<{ request_id: string }>("/videos/generations", {
      model: this.videoModel,
      prompt,
      image: { url: dataUrl(still) },
      duration: seconds,
      resolution: "480p",
    });
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.#pollMs));
      const job = await this.#call<{ status: string; video?: { url: string } }>(`/videos/${id}`);
      if (job.status === "done" && job.video) {
        const response = await this.#fetch(job.video.url);
        if (!response.ok) throw new Error(`The video download answered ${response.status}.`);
        return {
          bytes: new Uint8Array(await response.arrayBuffer()),
          contentType: "video/mp4",
          filename: "video.mp4",
        };
      }
      if (job.status !== "pending") throw new Error(`The video ended ${job.status}.`);
    }
  }
}

/** The text of every assistant message in Grok's output. */
export function outputText(output: ResponseItem[]): string {
  return output
    .flatMap((item) => ("type" in item && item.type === "message" ? item.content : []))
    .map((part) => (part.type === "output_text" ? part.text ?? "" : ""))
    .join("")
    .trim();
}

function decoded(result: { data?: { b64_json?: string }[] }): Media {
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("Grok Imagine returned no picture.");
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  const contentType = imageType(bytes);
  return { bytes, contentType, filename: `picture.${contentType.slice(6)}` };
}

export function dataUrl(media: Media): string {
  return `data:${media.contentType};base64,${Buffer.from(media.bytes).toString("base64")}`;
}

/** The image type from its first bytes. */
export function imageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "image/webp";
  throw new Error("Grok Imagine returned an image type this recipe does not know.");
}
