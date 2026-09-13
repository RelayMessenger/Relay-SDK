import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { expect, it } from "vitest";
import { inspectChannelEnv, readChannelEnv, renderChannelEnv, writeChannelEnv, writeEnvFile } from "./claude-channel.js";
import { expectOwnerOnly } from "./private-file.test.js";

const token = `rel_token_${"A".repeat(43)}`;
const other = `rel_token_${"B".repeat(43)}`;
const channel = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "relay-channel-")), "channels", "relay");

it("writes the three names the channel reads, owner-only, in an owner-only folder", async () => {
  const directory = await channel();
  const written = await writeChannelEnv(directory, { token, baseURL: "https://api.staging.relayapp.im", allowedSenders: ["advait"] });
  expect(written.path).toBe(join(directory, ".env"));
  const contents = await readFile(written.path, "utf8");
  expect(contents).toBe([
    `RELAY_AGENT_TOKEN="${token}"`,
    'RELAY_BASE_URL="https://api.staging.relayapp.im"',
    'RELAY_ALLOWED_SENDERS="advait"',
    "",
  ].join("\n"));
  await expectOwnerOnly(written.path, directory);
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
  await writeChannelEnv(directory, { token, baseURL: "https://api.staging.relayapp.im", allowedSenders: ["advait", "@advait", " "] });
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
  await writeChannelEnv(directory, { token: other, baseURL: "https://api.relayapp.im", allowedSenders: ["bob", "carol"] });
  const state = await inspectChannelEnv(directory);
  expect(state).toMatchObject({ exists: true, token: other, baseURL: "https://api.relayapp.im", allowedSenders: ["bob", "carol"] });
  // Keep changes nothing: the caller simply does not write.
  const before = await readFile(state.path, "utf8");
  expect(await readFile(state.path, "utf8")).toBe(before);
  // Replace overwrites only the token, and the file stays owner-only.
  await writeChannelEnv(directory, { token, baseURL: "https://api.relayapp.im", allowedSenders: ["bob", "carol"] });
  expect(await readFile(state.path, "utf8")).toContain(`RELAY_AGENT_TOKEN="${token}"`);
  expect(await readFile(state.path, "utf8")).not.toContain(other);
  await expectOwnerOnly(state.path, directory);
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


it("writes a Windows Hermes state directory that the shipped runtime reader preserves", async () => {
  const { parseEnvFile } = await import("../../claude-code/src/config.js");
  const { hermesStateDir } = await import("./connect.js");
  const original = String.raw`C:\Users\x\AppData\Roaming\hermes\relay`;
  const value = hermesStateDir({ env: { HERMES_HOME: String.raw`C:\Users\x\AppData\Roaming\hermes` }, home: String.raw`C:\Users\x`, platform: "win32", version: "0.1.6-staging.3", profile: "default", handle: "test.dev", allow: [], start: false });
  const directory = await channel();
  const written = await writeEnvFile(join(directory, ".env"), { RELAY_STATE_DIR: value }, "Hermes");
  const parsed = parseEnvFile(await readFile(written.path, "utf8"));
  expect(parsed.RELAY_STATE_DIR).toBe("C:/Users/x/AppData/Roaming/hermes/relay");
  expect(win32.normalize(parsed.RELAY_STATE_DIR!)).toBe(original);
  await expectOwnerOnly(written.path, directory);
});
