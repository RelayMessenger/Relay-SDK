/**
 * The three xAI calls this agent makes, on xAI's REST API (https://docs.x.ai):
 * Grok chat completions with tools, Grok Imagine image edits, and Grok Imagine
 * image-to-video. Every call takes the reference picture, so the character
 * looks the same in every picture and video.
 */

export const XAI_API = "https://api.x.ai/v1";

export interface XaiOptions {
  apiKey: string;
  fetch?: typeof fetch;
  /** Chat model. */
  model?: string;
  imageModel?: string;
  videoModel?: string;
  /** Milliseconds between video status checks. */
  pollMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
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
    this.model = options.model ?? "grok-4.20-non-reasoning";
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

  /** One Grok chat turn. The reply is either text or tool calls. */
  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatMessage> {
    const result = await this.#call<{ choices: { message: ChatMessage }[] }>(
      "/chat/completions",
      { model: this.model, messages, tools },
    );
    const message = result.choices[0]?.message;
    if (!message) throw new Error("Grok returned no message.");
    return message;
  }

  /** A first picture from words alone (POST /images/generations). */
  async generate(prompt: string): Promise<Media> {
    return decoded(await this.#call("/images/generations", {
      model: this.imageModel,
      prompt,
      response_format: "b64_json",
      n: 1,
    }));
  }

  /** A new picture of the character in the reference image (POST /images/edits). */
  async picture(reference: Media, prompt: string): Promise<Media> {
    return decoded(await this.#call("/images/edits", {
      model: this.imageModel,
      prompt,
      image: { url: dataUrl(reference) },
      response_format: "b64_json",
      n: 1,
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
