import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { InteractivePrompts } from "./interactive.js";

// The bridge connect keeps running is program.ts's own; only the ACP driver
// underneath it is replaced, so the test reads the signal program.ts hands it.
const bridge = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined, started: undefined as (() => void) | undefined }));
vi.mock("./acp-bridge.js", async (original) => ({
  ...(await original<typeof import("./acp-bridge.js")>()),
  acpCommand: async (command: string, args: readonly string[]) => ({ command, args: [...args] }),
  runAcpBridge: async (input: { signal: AbortSignal }) => {
    bridge.signal = input.signal;
    bridge.started?.();
    await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
  },
}));

const { runCLI } = await import("./program.js");

afterEach(() => { bridge.signal = undefined; bridge.started = undefined; });

const prompts = (): InteractivePrompts => ({
  select: vi.fn(async () => "new"),
  multiselect: vi.fn(async () => ["cursor"]),
  confirm: vi.fn(async () => true),
  password: vi.fn(async () => ""),
  text: vi.fn(async (_message, initial) => initial),
  info: vi.fn(), intro: vi.fn(), outro: vi.fn(), step: vi.fn(), success: vi.fn(), message: vi.fn(), note: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
});

// A service manager, `timeout`, `kill` and a closing terminal all stop a
// process with SIGTERM, not SIGINT. The bridge must stop the agent it started
// for both, or `cursor-agent acp` outlives connect (the orphan found 2026-09-26).
it.each(["SIGINT", "SIGTERM"] as const)("%s stops the ACP bridge connect keeps running, and then connect ends", async (signal) => {
  const scratch = join(tmpdir(), "relay-bridge-signals-test");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const token = `rel_token_${"C".repeat(43)}`;
  const started = new Promise<void>((resolve) => { bridge.started = resolve; });
  const before = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
  const run = runCLI(["connect", "cursor", "--token", token, "--yes", "--no-skill"], {
    configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, home, platform: process.platform },
    cwd: home, isInteractive: true, prompts: prompts(),
    fetch: vi.fn(async () => Response.json({ contact_cards: [{ handle: "calm_cangoo", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true }] })),
    stdout: () => undefined, stderr: () => undefined,
    connect: {
      sniff: async () => [{ id: "cursor", label: "Cursor", found: true }],
      observer: () => ({ semantics: "observational-no-ack", run: async () => undefined }),
      renderQR: () => "[QR]\n", version: "0.1.6-staging.0",
    },
  });
  await started;
  expect(bridge.signal?.aborted).toBe(false);
  process.emit(signal);
  expect(bridge.signal?.aborted).toBe(true);
  expect(await run).toBe(0);
  // Both listeners are gone again once the bridge has stopped.
  expect({ SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }).toEqual(before);
});
