// Every test file runs with its own throwaway HOME and OpenClaw state
// directory. OpenClaw keeps its databases under OPENCLAW_STATE_DIR, else
// ~/.openclaw, and the real ingress path opens them: a run with the real HOME
// opened the owner's ~/.openclaw databases on 2026-09-26. Nothing a test does
// may reach them.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "relay-openclaw-test-home-"));
const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
};
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.OPENCLAW_STATE_DIR = join(home, ".openclaw");

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10 });
});
