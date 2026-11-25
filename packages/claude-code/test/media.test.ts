import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Relay from "@relaymessenger/sdk";
import { MediaUploader } from "../src/media.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeRelay() {
  let seq = 0;
  const create = vi.fn(async () => {
    seq += 1;
    return {
      attachment_id: `att-${seq}`,
      upload_url: `https://upload.example/${seq}`,
      download_url: `https://cdn.example/${seq}`,
      http_method: "PUT" as const,
      expires_at: "2026-10-01T00:00:00.000Z",
      required_headers: {},
    };
  });
  const upload = vi.fn(async () => undefined);
  return {
    create,
    upload,
    relay: { attachments: { create, upload } } as unknown as Pick<Relay, "attachments">,
  };
}

describe("MediaUploader", () => {
  it("refuses files over 100 MiB before reading them and refuses empty files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-claude-media-"));
    dirs.push(dir);
    const huge = join(dir, "huge.png");
    writeFileSync(huge, "");
    truncateSync(huge, 104_857_600 + 1);
    const empty = join(dir, "empty.png");
    writeFileSync(empty, "");

    const { relay, create } = fakeRelay();
    const uploader = new MediaUploader(relay);

    await expect(uploader.parts([{ path: huge }], "k-huge")).rejects.toThrow(/exceeds maximum size/u);
    await expect(uploader.parts([{ path: empty }], "k-empty")).rejects.toThrow(/empty/u);
    expect(create).not.toHaveBeenCalled();
  });

  it("caps the upload dedupe cache size with LRU eviction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-claude-media-lru-"));
    dirs.push(dir);
    const file = join(dir, "tiny.txt");
    writeFileSync(file, "hi");

    const { relay, create } = fakeRelay();
    const uploader = new MediaUploader(relay);

    // Fill cache to cap (256) and push one more entry so key-0 is evicted.
    for (let i = 0; i < 257; i += 1) {
      await uploader.parts([{ path: file }], `key-${i}`);
    }
    expect(create).toHaveBeenCalledTimes(257);

    // Recent entry (key-256) hits cache without uploading again.
    await uploader.parts([{ path: file }], "key-256");
    expect(create).toHaveBeenCalledTimes(257);

    // Evicted oldest entry (key-0) must upload again.
    await uploader.parts([{ path: file }], "key-0");
    expect(create).toHaveBeenCalledTimes(258);
  });
});
