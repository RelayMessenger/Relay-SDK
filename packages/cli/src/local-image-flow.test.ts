import Relay from "@relaymessenger/sdk";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, resolveAuth } from "./config.js";
import { runCLI } from "./program.js";
import { protectWindowsPath } from "./runtime-connect/windows-acl.js";

const base = "https://api.staging.relayapp.im";
const handle = "local_picture.dev";
const secret = `rel_token_${"L".repeat(43)}`;
const attachmentID = "019a2123-1234-7890-abcd-123456789abc";
const original = { handle, first_name: "Local Picture", last_name: null, image_url: `${base}/assets/default.png`, is_active: true, kind: "agent" as const };
const permanent = { ...original, image_url: `${base}/images/copied.png` };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr4sAAAAASUVORK5CYII=", "base64");
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "relay-local-image-flow-")));
  if (process.platform === "win32") await protectWindowsPath(home, true);
  const path = join(home, "picture.png"); await writeFile(path, png);
  const configContext = { home, env: { RELAY_CONFIG_PATH: join(home, "config.json"), RELAY_API_URL: base } as NodeJS.ProcessEnv };
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const out: string[] = [];
  let fail: "upload" | "promotion" | "pending" | undefined;
  let current = original;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(base);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, path: url.pathname, ...(body ? { body } : {}) });
    if (method === "POST" && url.pathname === "/v1/agents") {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(body).not.toHaveProperty("image_recipe"); expect(body).not.toHaveProperty("image_url");
      return Response.json({ agent: original, secret, share_url: `https://go.staging.relayapp.im/@${handle}` }, { status: 201 });
    }
    if (method !== "PUT") expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
    if (method === "GET" && url.pathname === "/v1/contact_card") return Response.json({ contact_cards: [current] });
    if (method === "POST" && url.pathname === "/v1/attachments") {
      const saved = await readConfig(configContext);
      expect(saved.profiles[handle]?.agent_token).toBe(secret); // persisted BEFORE allocating/uploading
      expect(body).toEqual({ filename: "picture.png", content_type: "image/png", size_bytes: png.length });
      return Response.json({ attachment_id: attachmentID, upload_url: `${base}/fixture/upload`, download_url: `${base}/fixture/download`, http_method: "PUT", expires_at: "2026-09-09T00:00:00Z", required_headers: { "content-type": "image/png" } }, { status: 201 });
    }
    if (method === "PUT" && url.pathname === "/fixture/upload") {
      expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(png);
      if (fail === "upload") throw new Error(`untrusted-${secret}`);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.pathname === `/v1/attachments/${attachmentID}`) return Response.json({ id: attachmentID, status: fail === "pending" ? "pending" : "complete" });
    if (method === "PATCH" && url.pathname === "/v1/contact_card") {
      expect(url.searchParams.get("handle")).toBe(handle);
      expect(body).toHaveProperty("attachment_id", attachmentID);
      expect(body).not.toHaveProperty("handle"); expect(body).not.toHaveProperty("image_url");
      if (fail === "promotion") return Response.json({ error: { message: secret } }, { status: 503 });
      current = permanent;
      return Response.json(permanent);
    }
    throw new Error("Unexpected test request");
  };
  const deps = { configContext, fetch, isInteractive: false, stdout: (value: string) => out.push(value), stderr: (value: string) => out.push(value),
    resolveClient: async (profile?: string) => {
      const auth = await resolveAuth(profile, configContext);
      return { auth, client: new Relay({ apiKey: auth.token, baseURL: auth.apiURL, fetch, maxRetries: 0 }) };
    },
  };
  return { home, path, calls, deps, out, setFailure: (value: typeof fail) => { fail = value; } };
}
describe("saved-agent local image promotion", { timeout: 120_000 }, () => {
  it("preflights, creates/persists once, uploads, verifies completion, and PATCHes existing card", async () => {
    const f = await fixture();
    f.deps.configContext.env.RELAY_AGENT_TOKEN = "unrelated-env-identity";
    expect(await runCLI(["agents", "create", "--image", f.path, "--json"], f.deps)).toBe(0);
    expect(f.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/agents", "GET /v1/contact_card", "POST /v1/attachments", "PUT /fixture/upload", `GET /v1/attachments/${attachmentID}`, "PATCH /v1/contact_card",
    ]);
    const output = JSON.parse(f.out[0]!);
    expect(output.image_url).toBe(permanent.image_url); expect(output.agent).toBeUndefined(); expect(output.image.status).toBe("updated");
    expect(f.out.join("")).not.toContain(secret); expect(f.out.join("")).not.toContain("unrelated-env-identity");
  });
  it.each(["upload", "promotion", "pending"] as const)("retains identity/token and can retry existing image after %s failure without another bootstrap", async (failure) => {
    const f = await fixture(); f.setFailure(failure);
    expect(await runCLI(["agents", "create", "--image", f.path, "--json"], f.deps)).toBe(1);
    const partial = JSON.parse(f.out[0]!);
    expect(partial.handle).toBe(handle); expect(partial.token).toBe("stored"); expect(partial.image.status).toBe("incomplete");
    expect((await readConfig(f.deps.configContext)).profiles[handle]?.agent_token).toBe(secret);
    expect(f.out.join("")).not.toContain(secret);
    f.setFailure(undefined);
    const args = failure === "upload" ? ["--image", f.path] : ["--attachment-id", attachmentID];
    expect(await runCLI(["--profile", handle, "contact-card", "update", "--handle", handle, ...args], f.deps)).toBe(0);
    expect(f.calls.filter(({ method, path }) => method === "POST" && path === "/v1/agents")).toHaveLength(1);
    if (failure !== "upload") expect(f.calls.filter(({ path }) => path === "/fixture/upload")).toHaveLength(1);
  });
  it("uses a local rendered snapshot with advanced recipe metadata only on promotion", async () => {
    const f = await fixture(); const recipe = { recipe: { monogram: { initials: "LP" } }, background: { linearGradient: { colors: ["5B9BFA", "0B52C0"] } } };
    const recipePath = join(f.home, "recipe.json"); await writeFile(recipePath, JSON.stringify(recipe));
    expect(await runCLI(["agents", "create", "--image", f.path, "--image-recipe", recipePath, "--json"], f.deps)).toBe(0);
    expect(f.calls.find(({ method }) => method === "PATCH")?.body).toEqual({ attachment_id: attachmentID, image_recipe: recipe });
    expect((await readFile(f.path)).equals(png)).toBe(true);
  });
});
