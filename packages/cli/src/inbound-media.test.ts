import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaPartResponse } from "@relaymessenger/sdk";
import { downloadInboundMedia, inboundMediaPrompt } from "./inbound-media.js";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const setup = async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), "relay-inbound-media-"));
  folders.push(mediaDir);
  return { mediaDir, token: "secret", apiURL: "https://api.example", chatId: "chat-1" };
};
const photo: MediaPartResponse = { type: "media", id: "photo", url: "https://cdn.example/photo", filename: "../photo.png", mime_type: "image/png", size_bytes: 3, reactions: null };

describe("inbound media", () => {
  it("downloads every media part privately without forwarding auth to the CDN", async () => {
    const options = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("png"));
    const files = await downloadInboundMedia([photo, { ...photo, id: "pdf", filename: "file.pdf", mime_type: "application/pdf" }], { ...options, fetch });
    expect(files).toHaveLength(2);
    expect((files[0]?.ok ? files[0].path : undefined)).toBe(join(options.mediaDir, "chat-1", "photo-__photo.png"));
    expect(await readFile((files[0]!.ok ? files[0].path : ""), "utf8")).toBe("png");
    if (process.platform !== "win32") expect((await stat((files[0]!.ok ? files[0].path : ""))).mode & 0o777).toBe(0o600);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  });

  it("skips an existing file", async () => {
    const options = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("png"));
    const files = await downloadInboundMedia([photo], { ...options, fetch });
    expect(await downloadInboundMedia([photo], { ...options, fetch })).toEqual(files);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses bearer auth only for the API origin", async () => {
    const options = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("png"));
    await downloadInboundMedia([{ ...photo, url: "https://api.example/media/photo" }], { ...options, fetch });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("reports a failed download and still supplies the media-only turn", async () => {
    const options = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("no", { status: 403 }));
    expect(await downloadInboundMedia([photo], { ...options, fetch })).toEqual([{ ok: false, filename: "../photo.png", error: "Media could not be downloaded." }]);
    expect(await inboundMediaPrompt({ eventId: "event", chatId: "chat-1", sender: "alice", text: "", media: [photo] }, { ...options, fetch })).toEqual({ text: "Photo: could not be downloaded (../photo.png)", images: [] });
  });

  it("keeps successful files when another attachment fails", async () => {
    const options = await setup();
    const fetch: typeof globalThis.fetch = async (url) => String(url).endsWith("bad") ? new Response("no", { status: 404 }) : new Response("png");
    const result = await inboundMediaPrompt({ eventId: "event", chatId: "chat-1", sender: "alice", text: "hello", media: [photo, { ...photo, id: "bad", url: "https://cdn.example/bad", filename: "report.pdf", mime_type: "application/pdf" }] }, { ...options, fetch });
    expect(result.text).toContain("hello\nPhoto: ");
    expect(result.text).toContain("Attachment: could not be downloaded (report.pdf)");
    expect(result.images).toHaveLength(1);
  });

  it("uses the config directory and RELAY_MEDIA_DIR override", async () => {
    const options = await setup();
    const { mediaDir, ...auth } = options;
    const fetch: typeof globalThis.fetch = async () => new Response("png");
    const context = { env: { RELAY_CONFIG_PATH: join(mediaDir, "config.json") } };
    const [file] = await downloadInboundMedia([photo], { ...auth, fetch, context });
    expect((file?.ok ? file.path : undefined)).toBe(join(mediaDir, "media", "chat-1", "photo-__photo.png"));
    const [overridden] = await downloadInboundMedia([photo], { ...auth, fetch, context: { env: { ...context.env, RELAY_MEDIA_DIR: join(mediaDir, "override") } } });
    expect((overridden?.ok ? overridden.path : undefined)).toBe(join(mediaDir, "override", "chat-1", "photo-__photo.png"));
  });
});
