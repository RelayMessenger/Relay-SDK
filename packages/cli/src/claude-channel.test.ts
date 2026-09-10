import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectChannelEnv, readChannelEnv, renderChannelEnv, writeChannelEnv } from "./claude-channel.js";

const token = `rly_live_${"A".repeat(43)}`;
const other = `rly_live_${"B".repeat(43)}`;
const channel = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "relay-channel-")), "channels", "relay");

it("writes the three names the channel reads, owner-only, in an owner-only folder", async () => {
  const directory = await channel();
  const written = await writeChannelEnv(directory, { token, baseURL: "https://api.staging.relayapp.im", allowedSenders: ["advait"] }, "linux");
  expect(written.path).toBe(join(directory, ".env"));
  const contents = await readFile(written.path, "utf8");
  expect(contents).toBe([
    `RELAY_AGENT_TOKEN="${token}"`,
    'RELAY_BASE_URL="https://api.staging.relayapp.im"',
    'RELAY_ALLOWED_SENDERS="advait"',
    "",
  ].join("\n"));
  expect((await stat(written.path)).mode & 0o777).toBe(0o600);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  // The channel's own reader gets back exactly what was written.
  expect(readChannelEnv(contents)).toMatchObject({
    RELAY_AGENT_TOKEN: token,
    RELAY_BASE_URL: "https://api.staging.relayapp.im",
    RELAY_ALLOWED_SENDERS: "advait",
  });
});

it("keeps every other line where it was, and rewrites Relay's own in place", async () => {
  const directory = await channel();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".env"), [
    "# written by hand",
    `RELAY_AGENT_TOKEN="${other}"`,
    "RELAY_CHANNEL_SESSION_ID=my-project",
    'RELAY_BASE_URL="https://api.relayapp.im"',
    "",
  ].join("\n"), { mode: 0o600 });
  await writeChannelEnv(directory, { token, baseURL: "https://api.staging.relayapp.im", allowedSenders: ["advait", "@advait", " "] }, "linux");
  expect(await readFile(join(directory, ".env"), "utf8")).toBe([
    "# written by hand",
    `RELAY_AGENT_TOKEN="${token}"`,
    "RELAY_CHANNEL_SESSION_ID=my-project",
    'RELAY_BASE_URL="https://api.staging.relayapp.im"',
    'RELAY_ALLOWED_SENDERS="advait,@advait"',
    "",
  ].join("\n"));
});

it("reads back the token already there, so Keep and Replace can be offered", async () => {
  const directory = await channel();
  expect(await inspectChannelEnv(directory)).toMatchObject({ exists: false, allowedSenders: [] });
  await writeChannelEnv(directory, { token: other, baseURL: "https://api.relayapp.im", allowedSenders: ["bob", "carol"] }, "linux");
  const state = await inspectChannelEnv(directory);
  expect(state).toMatchObject({ exists: true, token: other, baseURL: "https://api.relayapp.im", allowedSenders: ["bob", "carol"] });
  // Keep changes nothing: the caller simply does not write.
  const before = await readFile(state.path, "utf8");
  expect(await readFile(state.path, "utf8")).toBe(before);
  // Replace overwrites only the token, and the file stays owner-only.
  await writeChannelEnv(directory, { token, baseURL: "https://api.relayapp.im", allowedSenders: ["bob", "carol"] }, "linux");
  expect(await readFile(state.path, "utf8")).toContain(`RELAY_AGENT_TOKEN="${token}"`);
  expect(await readFile(state.path, "utf8")).not.toContain(other);
  expect((await stat(state.path)).mode & 0o777).toBe(0o600);
});

it("refuses a value that a .env file cannot hold safely", () => {
  expect(() => renderChannelEnv("", { token: 'a"b', baseURL: "https://api.relayapp.im", allowedSenders: [] })).toThrow(/safely/u);
  expect(() => renderChannelEnv("", { token: "a\nb", baseURL: "https://api.relayapp.im", allowedSenders: [] })).toThrow(/safely/u);
  expect(() => renderChannelEnv("", { token: "a$b", baseURL: "https://api.relayapp.im", allowedSenders: [] })).toThrow(/safely/u);
});

it("leaves a file with no trailing newline ending in one, and never duplicates a name", () => {
  const rendered = renderChannelEnv(`RELAY_AGENT_TOKEN="${other}"`, { token, baseURL: "https://api.relayapp.im", allowedSenders: ["advait"] });
  expect(rendered.match(/RELAY_AGENT_TOKEN=/gu)).toHaveLength(1);
  expect(rendered.endsWith("\n")).toBe(true);
});
