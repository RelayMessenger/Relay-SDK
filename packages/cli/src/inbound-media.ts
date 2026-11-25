import { replyTargetContext, selectionReplyContext } from "@relaymessenger/sdk";
import type { MediaPartResponse, Message, ReplyTo } from "@relaymessenger/sdk";
import { lstat, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { configPath, type ConfigContext } from "./config.js";
import { openPrivateTemp, preparePrivateDestination, removeTemp, verifyPrivateACL } from "./private-file.js";
import type { BridgeTurn } from "./bridge-turn.js";

export interface InboundMediaOptions {
  chatId: string;
  token: string;
  apiURL: string;
  mediaDir?: string;
  context?: ConfigContext;
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
}

export type DownloadedMedia =
  | { ok: true; path: string; filename: string; mime_type: string }
  | { ok: false; filename: string; error: string };

const MAX_INBOUND_MEDIA_BYTES = 104_857_600;

const safeName = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/gu, "_").replace(/^\.+/u, "_") || "attachment";

const readBoundedBytes = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && lengthHeader.trim() !== "") {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Media exceeds maximum size of ${maxBytes} bytes (${declared} bytes).`);
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Media exceeds maximum size of ${maxBytes} bytes (${bytes.byteLength} bytes).`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Media exceeds maximum size of ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** External media URLs do not receive the Relay bearer token. */
export const downloadInboundMedia = async (
  parts: readonly MediaPartResponse[], options: InboundMediaOptions,
): Promise<DownloadedMedia[]> => {
  if (parts.length === 0) return [];
  const env = options.context?.env ?? process.env;
  const maxBytes = options.maxBytes ?? MAX_INBOUND_MEDIA_BYTES;
  const files: DownloadedMedia[] = [];
  for (const part of parts) {
    try {
      if (part.size_bytes !== undefined && part.size_bytes > maxBytes) {
        throw new Error(`Media exceeds maximum size of ${maxBytes} bytes (${part.size_bytes} bytes).`);
      }
      const mediaDir = resolve(options.mediaDir ?? env.RELAY_MEDIA_DIR ?? join(dirname(configPath(options.context)), "media"));
      const path = join(mediaDir, safeName(options.chatId), `${safeName(part.id)}-${safeName(part.filename)}`);
      const destination = await preparePrivateDestination(path, "Relay media", options.context?.platform);
      const exists = await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (!exists) {
        const url = new URL(part.url, options.apiURL);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported media URL.");
        const headers = new Headers();
        if (url.origin === new URL(options.apiURL).origin) headers.set("authorization", `Bearer ${options.token}`);
        const response = await (options.fetch ?? globalThis.fetch)(url, { headers, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`Media download failed (${response.status}).`);
        const bytes = await readBoundedBytes(response, maxBytes);
        const temporary = await openPrivateTemp(destination, ".media");
        try {
          try { await temporary.handle.writeFile(bytes); await temporary.handle.sync(); }
          finally { await temporary.handle.close(); }
          await rename(temporary.path, path);
          await verifyPrivateACL(path, destination);
        } finally { await removeTemp(temporary.path); }
      }
      files.push({ ok: true, path, filename: part.filename, mime_type: part.mime_type });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[relay] Failed to download inbound media ${part.id} (${part.filename.replace(/[\r\n]/gu, " ")}): ${reason}`);
      files.push({ ok: false, filename: part.filename, error: "Media could not be downloaded." });
    }
  }
  return files;
};

/**
 * The Message a reply names, read once with GET /v1/messages/{id}. A read that
 * fails leaves the target unread, and the prompt names it by id instead.
 */
const readReplyTarget = async (
  replyTo: ReplyTo, options: Omit<InboundMediaOptions, "chatId"> | undefined,
): Promise<Message | undefined> => {
  if (!options) return undefined;
  try {
    const url = new URL(`/v1/messages/${encodeURIComponent(replyTo.message_id)}`, options.apiURL);
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok ? await response.json() as Message : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[relay] Failed to read reply target ${replyTo.message_id}: ${reason}`);
    return undefined;
  }
};

/** A failed attachment is named in the turn; it never consumes the message. */
export const inboundMediaPrompt = async (
  turn: BridgeTurn, options?: Omit<InboundMediaOptions, "chatId">,
): Promise<{ text: string; images: string[] }> => {
  const lines = turn.text ? [turn.text.slice(0, 65_536)] : [];
  if (turn.replying) lines.push(replyTargetContext(turn.replying, await readReplyTarget(turn.replying, options)));
  const context = selectionReplyContext(turn.selection, turn.richMessage);
  if (context) lines.push(context);
  const images: string[] = [];
  const files = options
    ? await downloadInboundMedia(turn.media, { ...options, chatId: turn.chatId })
    : turn.media.map((part): DownloadedMedia => ({ ok: false, filename: part.filename, error: "Media download configuration is missing." }));
  for (const [index, file] of files.entries()) {
    const part = turn.media[index]!;
    const label = part.mime_type.startsWith("image/") ? "Photo" : "Attachment";
    if (file.ok) {
      lines.push(`${label}: ${file.path}`);
      if (file.mime_type.startsWith("image/")) images.push(file.path);
    } else {
      lines.push(`${label}: could not be downloaded (${file.filename.replace(/[\r\n]/gu, " ")})`);
    }
  }
  return { text: lines.join("\n"), images };
};
