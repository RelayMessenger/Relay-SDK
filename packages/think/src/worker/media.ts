const MAX_GATEWAY_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_SAMPLE_RATE = 24_000;

export interface MediaGatewayEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  CLOUDFLARE_AI_GATEWAY_TOKEN?: string;
  VERTEX_PROJECT_ID: string;
  VERTEX_LOCATION: string;
  VERTEX_IMAGE_MODEL?: string;
  VERTEX_TTS_MODEL?: string;
  VERTEX_TTS_VOICE?: string;
}

interface InlineData {
  data: string;
  mimeType?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: InlineData;
        text?: string;
      }>;
    };
  }>;
}

export class MediaGenerationError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MediaGenerationError";
  }
}

function requireSetting(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new MediaGenerationError(`${name} is not configured`);
  }
  return value;
}

function gatewayEndpoint(env: MediaGatewayEnv, model: string): string {
  const account = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  const gateway = encodeURIComponent(env.AI_GATEWAY_ID);
  const project = encodeURIComponent(env.VERTEX_PROJECT_ID);
  const location = encodeURIComponent(env.VERTEX_LOCATION);
  const modelID = encodeURIComponent(model);
  return `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/google-vertex-ai/v1/`
    + `projects/${project}/locations/${location}/publishers/google/models/`
    + `${modelID}:generateContent`;
}

async function boundedText(response: Response, provider = "Gemini"): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GATEWAY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MediaGenerationError(`${provider} media response was too large`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function generate(
  env: MediaGatewayEnv,
  model: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<GeminiResponse> {
  const token = requireSetting(env.CLOUDFLARE_AI_GATEWAY_TOKEN, "CLOUDFLARE_AI_GATEWAY_TOKEN");
  const response = await fetch(gatewayEndpoint(env, model), {
    method: "POST",
    headers: {
      "cf-aig-authorization": `Bearer ${token}`,
      "cf-aig-max-attempts": "2",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  });
  const text = await boundedText(response);
  if (!response.ok) {
    throw new MediaGenerationError(
      `Gemini media generation failed with HTTP ${response.status}`,
      response.status,
    );
  }
  try {
    return JSON.parse(text) as GeminiResponse;
  } catch {
    throw new MediaGenerationError("Gemini returned invalid media JSON");
  }
}

function inlineData(response: GeminiResponse, kind: "audio" | "image"): InlineData {
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (
        part.inlineData?.data
        && part.inlineData.mimeType?.toLowerCase().startsWith(`${kind}/`)
      ) {
        return part.inlineData;
      }
    }
  }
  throw new MediaGenerationError(`Gemini returned no ${kind}`);
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new MediaGenerationError("Gemini returned invalid base64 media");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png" | "image/webp";
}

export async function generateImage(
  env: MediaGatewayEnv,
  prompt: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const model = requireSetting(env.VERTEX_IMAGE_MODEL, "VERTEX_IMAGE_MODEL");
  const response = await generate(env, model, {
    contents: [{
      role: "user",
      parts: [{ text: prompt }],
    }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "1:1" },
    },
  }, signal);
  const image = inlineData(response, "image");
  const type = image.mimeType?.split(";", 1)[0]?.toLowerCase();
  if (type !== "image/jpeg" && type !== "image/png" && type !== "image/webp") {
    throw new MediaGenerationError(
      `Gemini returned unsupported image type ${type ?? "unknown"}`,
    );
  }
  return { bytes: decodeBase64(image.data), contentType: type };
}

function sampleRate(mimeType: string | undefined): number {
  const match = /(?:rate|rate=)(\d+)/iu.exec(mimeType ?? "");
  const parsed = match ? Number.parseInt(match[1]!, 10) : DEFAULT_SAMPLE_RATE;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_RATE;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

export function wavFromPCM(pcm: Uint8Array, rate: number): Uint8Array {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = rate * blockAlign;
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  const wav = new Uint8Array(buffer);
  wav.set(pcm, 44);
  return wav;
}

export interface GeneratedVoiceMemo {
  bytes: Uint8Array;
  contentType: "audio/x-wav";
  durationMs: number;
}

export async function generateVoiceMemo(
  env: MediaGatewayEnv,
  text: string,
  style?: string,
  signal?: AbortSignal,
): Promise<GeneratedVoiceMemo> {
  const model = requireSetting(env.VERTEX_TTS_MODEL, "VERTEX_TTS_MODEL");
  const voiceName = requireSetting(env.VERTEX_TTS_VOICE, "VERTEX_TTS_VOICE");
  const response = await generate(env, model, {
    contents: [{
      role: "user",
      parts: [{ text: style ? `${style}: ${text}` : text }],
    }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName,
          },
        },
      },
    },
  }, signal);
  const audio = inlineData(response, "audio");
  const rate = sampleRate(audio.mimeType);
  const pcm = decodeBase64(audio.data);
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new MediaGenerationError("Gemini returned invalid PCM audio");
  }
  return {
    bytes: wavFromPCM(pcm, rate),
    contentType: "audio/x-wav",
    durationMs: Math.max(1, Math.round(pcm.byteLength / 2 / rate * 1_000)),
  };
}
