import { mkdtemp, mkdir, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareAgentImage } from "./local-image.js";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr4sAAAAASUVORK5CYII=", "base64");
it("preflights a local image and retains its exact bytes without HTTP", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-local-image-")); await writeFile(join(home, "picture.png"), png);
  const result = await prepareAgentImage("~/picture.png", { home });
  expect(result.kind).toBe("file");
  if (result.kind === "file") { expect(result.file.contentType).toBe("image/png"); expect(Buffer.from(result.file.data)).toEqual(png); expect(result.file.filename).toBe("picture.png"); }
});
it("accepts HTTPS URL input without fetching it", async () => {
  expect(await prepareAgentImage("https://images.example.test/pic.png")).toEqual({ kind: "url", url: "https://images.example.test/pic.png" });
  await expect(prepareAgentImage("https://secret@images.example.test/pic.png")).rejects.toThrow("must not contain a user name or password");
});
it("rejects missing, directory, empty, unsupported, signature-mismatched, and oversized files locally", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "relay-local-image-invalid-"));
  await mkdir(join(cwd, "dir.png")); await writeFile(join(cwd, "empty.png"), ""); await writeFile(join(cwd, "wrong.png"), "not image data"); await writeFile(join(cwd, "wrong.txt"), png);
  await writeFile(join(cwd, "large.png"), png); await truncate(join(cwd, "large.png"), 1000);
  // Each rule names itself: a reader must learn which one they broke, and
  // "No agent was created" belongs only to `agents create`, never here.
  const reasons: Array<[string, string | RegExp]> = [
    ["absent.png", "Relay could not read"],
    ["dir.png", "must be a regular file"],
    ["empty.png", "between 1 byte and 100 bytes"],
    ["wrong.png", "are not PNG"],
    ["wrong.txt", "Relay does not accept .txt"],
    ["large.png", "between 1 byte and 100 bytes"],
  ];
  for (const [path, reason] of reasons) {
    await expect(prepareAgentImage(path, { cwd, maxBytes: 100 })).rejects.toThrow(reason);
    await expect(prepareAgentImage(path, { cwd, maxBytes: 100 })).rejects.not.toThrow("No agent was created");
  }
});
