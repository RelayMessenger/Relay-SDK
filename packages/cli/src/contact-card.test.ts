import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeConfig } from "./config.js";
import { runCLI } from "./program.js";
import { protectWindowsPath } from "./runtime-connect/windows-acl.js";

describe("contact-card profile selection", () => {
  it.each(["setup", "update", "set"])("%s uses the current profile token and handle without --handle", async (command) => {
    await check(command);
  });
  it.each(["setup", "update", "set"])("%s uses an explicit handle with the current profile token", async (command) => {
    await check(command, "explicit_agent");
  });
});

async function check(command: string, explicitHandle?: string) {
  const home = await mkdtemp(join(tmpdir(), "relay-contact-card-"));
  if (process.platform === "win32") await protectWindowsPath(home, true);
  const configContext = { home, env: { RELAY_CONFIG_PATH: join(home, "config.json") } };
  await writeConfig({ version: 1, current_profile: "work", profiles: {
    work: { agent_token: "current-profile-token", api_url: "https://api.staging.relayapp.im" },
    other: { agent_token: "other-profile-token" },
  } }, configContext);
  const calls: Array<{ method: string; handle: string | null; body: Record<string, unknown> }> = [];
  const errors: string[] = [];
  const card = { handle: "current_agent", first_name: "Current", last_name: null, image_url: null, kind: "agent", is_active: true };
  const result = await runCLI(["contact-card", command, "--name", "Changed", ...(explicitHandle ? ["--handle", explicitHandle] : [])], {
    configContext, cwd: home,
    stdout: () => {}, stderr: (value) => errors.push(value),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer current-profile-token");
      expect(url.pathname).toBe("/v1/contact_card");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method, handle: url.searchParams.get("handle"), body });
      return Response.json(method === "GET" ? { contact_cards: [card] } : card);
    },
  });
  expect(result, errors.join("")).toBe(0);
  expect(calls.map((call) => call.method)).toEqual([...(explicitHandle ? [] : ["GET"]), command === "setup" ? "POST" : "PATCH"]);
  const mutation = calls.at(-1)!;
  const expectedHandle = explicitHandle ?? card.handle;
  expect(command === "setup" ? mutation.body.handle : mutation.handle).toBe(expectedHandle);
  expect(mutation.body.first_name).toBe("Changed");
}
