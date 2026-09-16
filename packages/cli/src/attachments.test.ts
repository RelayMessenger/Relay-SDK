import type Relay from "@relaymessenger/sdk";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCLI } from "./program.js";

async function upload(filename: string, data: Buffer, args: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "relay-attachments-"));
  const file = join(directory, filename);
  await writeFile(file, data);
  const allocation = { attachment_id: "attachment-1" };
  const create = vi.fn(async () => allocation);
  const send = vi.fn(async () => undefined);
  const resolveClient = vi.fn(async () => ({
    client: { attachments: { create, upload: send } } as unknown as Relay,
    auth: { profile: "default", apiURL: "https://api.relayapp.im", token: "test-token",
      tokenSource: "environment" as const, configPath: join(directory, "config.json") },
  }));
  const errors: string[] = [];
  const code = await runCLI(["attachments", "upload", file, ...args], {
    resolveClient, stdout: () => {}, stderr: (value) => errors.push(value),
  });
  return { code, errors, create, send, resolveClient, allocation };
}

it.each([
  ["89504e470d0a1a0a", "image/png"],
  ["ffd8ffe0", "image/jpeg"],
  ["474946383961", "image/gif"],
  ["255044462d", "application/pdf"],
  ["524946460000000057454250", "image/webp"],
])("sniffs %s without --content-type and before the extension", async (hex, contentType) => {
  const data = Buffer.from(hex, "hex");
  const result = await upload("file.txt", data);
  expect(result.code, result.errors.join("\n")).toBe(0);
  expect(result.create).toHaveBeenCalledWith({ filename: "file.txt", content_type: contentType, size_bytes: data.length });
  expect(result.send).toHaveBeenCalledWith(result.allocation, data);
});

it("falls back to the case-insensitive extension", async () => {
  const result = await upload("notes.TXT", Buffer.from("hello"));
  expect(result.code).toBe(0);
  expect(result.create).toHaveBeenCalledWith({ filename: "notes.TXT", content_type: "text/plain", size_bytes: 5 });
});

it("preserves an explicit content type", async () => {
  const result = await upload("file", Buffer.from("89504e47", "hex"), ["--content-type", "application/pdf"]);
  expect(result.code).toBe(0);
  expect(result.create).toHaveBeenCalledWith({ filename: "file", content_type: "application/pdf", size_bytes: 4 });
});

it.each(["", "RIFFxxxxNOTP", "unknown"])("refuses unknown bytes %j without an extension before allocating", async (bytes) => {
  const result = await upload("file", Buffer.from(bytes));
  expect(result.code).not.toBe(0);
  expect(result.errors.join("\n")).toContain("Could not detect the file type. Set --content-type");
  expect(result.resolveClient).not.toHaveBeenCalled();
  expect(result.create).not.toHaveBeenCalled();
});

it("does not treat inherited object keys as file extensions", async () => {
  const result = await upload("file.constructor", Buffer.from("unknown"));
  expect(result.code).not.toBe(0);
  expect(result.create).not.toHaveBeenCalled();
});
