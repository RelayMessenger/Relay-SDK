import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runTerminalSession } from "./terminal-session.js";
import { QR_LIGHT, renderTerminalQR } from "./qr-terminal.js";
import { terminalText, terminalEventLine, sdkTerminalObserver, type TerminalObserver } from "./terminal-watch.js";

function fixture(rows = 40) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode: vi.fn((raw: boolean) => { input.isRaw = raw; }) });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows,
    write: vi.fn((_text: string) => true) });
  const signals = new EventEmitter() as unknown as NodeJS.Process;
  const text = () => output.write.mock.calls.map(([value]) => value).join("");
  return { input, output, signals, text, renderQR: vi.fn(async () => "██ QR ██\n██ QR ██") };
}
const options = { interactive: true, agent: { handle: "owned", shareUrl: "https://go.staging.relaymessenger.com/owned" }, runtime: { ownership: "external" as const, connection: "unknown" as const } };
const turn = () => new Promise(resolve => setTimeout(resolve, 80));
it("persists QR with a real observer adapter, separates runtime readiness, restores terminal on quit", async () => {
  const f = fixture(); let stopped = false;
  const observer: TerminalObserver = { semantics: "observational-no-ack", async run({ signal, onStatus, onEvent }) {
    onStatus("ready"); onEvent({ event_type: "contact.added", event_id: "owned-event", data: {} } as any);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }));
  } };
  const pending = runTerminalSession({ ...options, observer }, f);
  await turn();
  expect(f.text()).toContain("██ QR ██"); expect(f.text()).toContain("watching only; your agent still receives every message"); expect(f.text()).not.toMatch(/ACK|listener|retention|Runtime/);
  expect(f.text()).toContain("Agent: connection not checked"); expect(f.text()).toContain("contact.added");
  expect(f.renderQR).toHaveBeenCalledExactlyOnceWith(options.agent.shareUrl);
  expect(stopped).toBe(false); f.input.write("q");
  expect(await pending).toEqual({ reason: "quit", observedEvents: 1, observerStopped: true });
  expect(stopped).toBe(true); expect(f.input.isRaw).toBe(false);
  expect(f.input.listenerCount("data")).toBe(0); expect(f.output.listenerCount("resize")).toBe(0);
  expect(f.text()).toContain("\x1b[?1049l"); f.input.destroy();
});
it("nonTTY and explicit script mode never open an observer", async () => {
  const f = fixture(); const run = vi.fn(); f.input.isTTY = false;
  expect((await runTerminalSession({ ...options, observer: { semantics: "observational-no-ack", run } }, f)).reason).toBe("non-interactive");
  f.input.isTTY = true;
  expect((await runTerminalSession({ ...options, interactive: false }, f)).reason).toBe("non-interactive");
  expect(run).not.toHaveBeenCalled(); expect(f.output.write).not.toHaveBeenCalled(); f.input.destroy();
});
it("redacts secrets/control injection without displaying raw event objects", () => {
  expect(terminalText("\x1b[31mhello\x1b[0m\nprivate-token\u202e", ["private-token"])).toBe("hello [REDACTED]");
  const line = terminalEventLine({ event_type: "message.received", event_id: "event", data: { token: "private-token", parts: [{ type: "text", value: "hello private-token" }] } } as any, ["private-token"]);
  expect(line).toContain("hello [REDACTED]"); expect(line).not.toContain("private-token");
});
it("rejects secret-reflected QR metadata and restores state on abort", async () => {
  const f = fixture(); const controller = new AbortController();
  const pending = runTerminalSession({ ...options, secrets: ["private-token"], agent: { ...options.agent, shareUrl: "https://go.staging.relaymessenger.com/private-token" }, signal: controller.signal }, f);
  await turn(); controller.abort();
  expect((await pending).reason).toBe("aborted"); expect(f.renderQR).not.toHaveBeenCalled();
  expect(f.text()).not.toContain("private-token"); expect(f.input.isRaw).toBe(false); f.input.destroy();
});
it("uses SDK observe:true and never fabricates a consuming fallback", async () => {
  const run = vi.fn(async (input: any) => { input.onConnectionState("ready"); await input.onEvent({ event_type: "contact.added" }); });
  const onStatus = vi.fn(); const onEvent = vi.fn();
  await sdkTerminalObserver({ websocket: { run } } as any).run({ signal: new AbortController().signal, onStatus, onEvent });
  expect(run.mock.calls[0]?.[0].observe).toBe(true); expect(onStatus).toHaveBeenCalledWith("ready"); expect(onEvent).toHaveBeenCalledOnce();
});

it("resizes without clipping QR and bounds output to terminal height", async () => {
  const f = fixture(24); f.output.columns = 80;
  f.renderQR.mockResolvedValue(Array.from({ length: 18 }, () => "█".repeat(33)).join("\n"));
  const pending = runTerminalSession(options, f); await turn();
  const last = () => f.output.write.mock.calls.at(-1)![0];
  expect(last()).not.toContain("Enlarge terminal");
  expect(last().split("\n").length).toBeLessThanOrEqual(24);
  f.output.columns = 20; f.output.rows = 10; f.output.emit("resize"); await turn();
  expect(last().split("\n").length).toBeLessThanOrEqual(10);
  f.input.write("\x04"); await pending; f.input.destroy();
});

it("shows the same compact QR in short and tall windows, never a size complaint", async () => {
  // The real renderer, not the fixture's stand-in: this is the size rule itself.
  const f = fixture(24); f.output.columns = 80;
  const pending = runTerminalSession(options, {
    input: f.input, output: f.output, signals: f.signals,
    renderQR: async url => renderTerminalQR(url, { terminalProgram: "ghostty" }),
  });
  await turn();
  const last = (): string => f.output.write.mock.calls.at(-1)![0];
  expect(last()).toMatch(/[▀▄█]/u);
  expect(last()).not.toContain("Enlarge terminal");
  expect(last()).not.toContain("QR unavailable");
  expect(last().split("\n").length).toBeLessThanOrEqual(24);
  // A tall window keeps the same compact rendering.
  f.output.rows = 60; f.output.emit("resize"); await turn();
  expect(last()).toContain("[48;5;16m");
  expect(last()).toMatch(/[▀▄█]/u);
  expect(last()).not.toContain("Enlarge terminal");
  // Wider windows also keep the compact rendering.
  f.output.rows = 40; f.output.columns = 100; f.output.emit("resize"); await turn();
  expect(last()).toMatch(/[▀▄█]/u);
  expect(last()).not.toContain("Enlarge terminal");
  f.input.write("q"); await pending; f.input.destroy();
});

it("shows Apple Terminal's whole solid QR after a resize, never a partial code", async () => {
  const f = fixture(24);
  f.renderQR.mockImplementation(async () => renderTerminalQR(options.agent.shareUrl, { terminalProgram: "Apple_Terminal" }));
  const pending = runTerminalSession(options, f);
  await turn();
  const last = (): string => f.output.write.mock.calls.at(-1)![0];
  expect(last()).toContain("Enlarge terminal");
  expect(last()).not.toContain(QR_LIGHT);
  f.output.rows = 60; f.output.emit("resize"); await turn();
  expect(last()).toContain(QR_LIGHT);
  expect(last()).not.toContain("Enlarge terminal");
  f.output.columns = 40; f.output.emit("resize"); await turn();
  expect(last()).toContain("Enlarge terminal");
  expect(last()).not.toContain(QR_LIGHT);
  f.output.columns = 100; f.output.emit("resize"); await turn();
  expect(last()).toContain(QR_LIGHT);
  expect(f.renderQR).toHaveBeenCalledOnce();
  f.input.write("q"); await pending; f.input.destroy();
});

it("sanitizes observer exceptions and handles EOF without changing an external runtime", async () => {
  const f = fixture();
  const observer: TerminalObserver = { semantics: "observational-no-ack", async run() { throw Error("Bearer private-token"); } };
  const pending = runTerminalSession({ ...options, observer }, f); await turn();
  expect(f.text()).toContain("unavailable"); expect(f.text()).not.toContain("private-token");
  f.input.end(); expect((await pending).reason).toBe("input-ended");
  expect(f.input.isRaw).toBe(false); f.input.destroy();
});
