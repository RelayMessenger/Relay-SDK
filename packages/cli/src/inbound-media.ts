import { selectionReplyContext } from "@relaymessenger/sdk";
import type { MediaPartResponse } from "@relaymessenger/sdk";
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
}

export type DownloadedMedia =
  | { ok: true; path: string; filename: string; mime_type: string }
  | { ok: false; filename: string; error: string };

const safeName = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/gu, "_").replace(/^\.+/u, "_") || "attachment";

/** External media URLs do not receive the Relay bearer token. */
export const downloadInboundMedia = async (
  parts: readonly MediaPartResponse[], options: InboundMediaOptions,
): Promise<DownloadedMedia[]> => {
  if (parts.length === 0) return [];
  const env = options.context?.env ?? process.env;
  const files: DownloadedMedia[] = [];
  for (const part of parts) {
    try {
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
        const bytes = new Uint8Array(await response.arrayBuffer());
        const temporary = await openPrivateTemp(destination, ".media");
        try {
          try { await temporary.handle.writeFile(bytes); await temporary.handle.sync(); }
          finally { await temporary.handle.close(); }
          await rename(temporary.path, path);
          await verifyPrivateACL(path, destination);
        } finally { await removeTemp(temporary.path); }
      }
      files.push({ ok: true, path, filename: part.filename, mime_type: part.mime_type });
    } catch {
      files.push({ ok: false, filename: part.filename, error: "Media could not be downloaded." });
    }
  }
  return files;
};

/** A failed attachment is named in the turn; it never consumes the message. */
export const inboundMediaPrompt = async (
  turn: BridgeTurn, options?: Omit<InboundMediaOptions, "chatId">,
): Promise<{ text: string; images: string[] }> => {
  const lines = turn.text ? [turn.text] : [];
  const context = selectionReplyContext(turn.selection);
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
