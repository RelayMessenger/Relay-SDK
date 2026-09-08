import { createRequire } from "node:module";
import { stripVTControlCharacters } from "node:util";
import { runTerminalWatch, terminalText, type TerminalObserver, type TerminalRuntimeOwnership, type TerminalWatchStatus } from "./terminal-watch.js";

export interface TerminalAgent {
  handle: string;
  name?: string;
  shareUrl: string;
  profile?: string;
}
export interface TerminalRuntimeState {
  ownership: TerminalRuntimeOwnership;
  /** Set from what the runtime itself shows. A live view that has connected does NOT mean the agent is running. */
  connection: "unknown" | "not-started" | "connected" | "disconnected";
  label?: string;
}
export interface TerminalSessionOptions {
  agent: TerminalAgent;
  runtime: TerminalRuntimeState;
  observer?: TerminalObserver;
  secrets?: readonly string[];
  signal?: AbortSignal;
  interactive?: boolean;
}
export interface TerminalInput {
  isTTY?: boolean;
  isRaw?: boolean;
  readableFlowing?: boolean | null;
  setRawMode?(enabled: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
export interface TerminalOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(value: string): unknown;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}
export interface TerminalSessionIO {
  input?: TerminalInput;
  output?: TerminalOutput;
  signals?: Pick<NodeJS.Process, "on" | "off">;
  renderQR?: (publicUrl: string) => Promise<string>;
}
export interface TerminalSessionResult {
  reason: "quit" | "aborted" | "input-ended" | "non-interactive" | "terminal-error";
  observedEvents: number;
  observerStopped: boolean;
}
const ENTER_SCREEN = "\u001b[?1049h\u001b[?25l";
const LEAVE_SCREEN = "\u001b[0m\u001b[?25h\u001b[?1049l";
const CLEAR = "\u001b[H\u001b[2J";
const HELP = "c · redraw QR    ? · help    q / Ctrl-C / Ctrl-D · stop viewing";
const defaultQR = async (url: string): Promise<string> => {
  const qr = createRequire(import.meta.url)("qrcode") as { toString(value: string, options: { type: "terminal"; small: boolean }): Promise<string> };
  return await qr.toString(url, { type: "terminal", small: true });
};
function publicShareUrl(value: string, secrets: readonly string[]): string | undefined {
  if (value.length > 1024 || terminalText(value, secrets, 1024) !== value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return;
    return url.toString();
  } catch { return; }
}
export function terminalRuntimeLabel(runtime: TerminalRuntimeState, secrets: readonly string[] = []): string {
  const name = terminalText(runtime.label, secrets, 40);
  // Plain words for the person at the terminal (owner, 2026-09-08: a label he
  // has to ask about is a defect). The agent is "running" when a connected
  // runtime answers for it; until then nothing answers its messages.
  const labels = { unknown: "connection not checked", "not-started": "not running yet; nothing answers its messages until you connect one", connected: "running", disconnected: "not connected" };
  return `Agent${name ? ` (${name})` : ""}: ${labels[runtime.connection] ?? labels.unknown}`;
}

/** Persistent view only. Closing it does not delete the agent or start/stop any runtime. */
export async function runTerminalSession(options: TerminalSessionOptions, io: TerminalSessionIO = {}): Promise<TerminalSessionResult> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stderr;
  const signals = io.signals ?? process;
  const interactive = options.interactive ?? Boolean(process.stdout.isTTY && !process.env.CI);
  if (!interactive || !input.isTTY || !output.isTTY || !input.setRawMode) {
    return { reason: "non-interactive", observedEvents: 0, observerStopped: true };
  }
  if (options.signal?.aborted) return { reason: "aborted", observedEvents: 0, observerStopped: true };
  const secrets = options.secrets ?? [];
  const share = publicShareUrl(options.agent.shareUrl, secrets);
  let qr = "";
  if (share) {
    try { qr = await (io.renderQR ?? defaultQR)(share); if (qr.length > 20000) qr = ""; }
    catch { /* Public link remains usable; QR exceptions are never displayed. */ }
  }
  if (options.signal?.aborted) return { reason: "aborted", observedEvents: 0, observerStopped: true };
  const control = new AbortController();
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  const lines: string[] = [];
  let events = 0;
  let watch: TerminalWatchStatus = "unavailable";
  let stopped = false;
  let help = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let resolveExit!: (reason: TerminalSessionResult["reason"]) => void;
  const exit = new Promise<TerminalSessionResult["reason"]>(resolve => { resolveExit = resolve; });
  const stop = (reason: TerminalSessionResult["reason"]): void => {
    if (stopped) return;
    stopped = true; control.abort(); resolveExit(reason);
  };
  const render = (): void => {
    scheduled = undefined;
    if (stopped) return;
    const width = Math.max(1, Math.min(output.columns ?? 100, 240));
    const height = Math.max(1, Math.min(output.rows ?? 30, 100));
    const title = terminalText(options.agent.name, secrets, width) || "Relay agent";
    const handle = terminalText(options.agent.handle, secrets, width);
    const profile = terminalText(options.agent.profile, secrets, width);
    const info = [`${title} · @${handle}`, ...(profile ? [`Profile: ${profile}`] : [])];
    info.push(share ?? "Relay could not build the public link for this agent.");
    info.push(terminalRuntimeLabel(options.runtime, secrets));
    // This view only watches. It never answers and never takes an event, so the
    // runtime you chose still receives every message. Say that in the reader's
    // own words, never in wire vocabulary.
    const statuses = { connecting: "connecting", ready: "watching only; your agent still receives every message", disconnected: "disconnected", unavailable: "unavailable", gap: "watching; some earlier events are not shown" };
    info.push(`Live view: ${statuses[watch]}`);
    if (options.runtime.ownership !== "none") info.push("This view does not start or stop your agent.");
    if (help) info.push("This view only watches. It does not answer messages or change anything.");
    const qrLines = qr.trimEnd().split("\n");
    const qrWidth = Math.max(...qrLines.map(line => stripVTControlCharacters(line).length));
    const wrap = (value: string, columns: number): string[] => {
      const chars = Array.from(value); const result: string[] = [];
      for (let index = 0; index < chars.length; index += columns) result.push(chars.slice(index, index + columns).join(""));
      return result.length ? result : [""];
    };
    let header: string[];
    const sideWidth = width - qrWidth - 3;
    const sideInfo = sideWidth >= 30 ? info.flatMap(line => wrap(line, sideWidth)) : [];
    if (qr && sideWidth >= 30 && Math.max(qrLines.length, sideInfo.length) + 2 <= height) {
      header = Array.from({ length: Math.max(qrLines.length, sideInfo.length) }, (_, i) => {
        const left = qrLines[i] ?? "";
        return left + " ".repeat(qrWidth - stripVTControlCharacters(left).length + 3) + (sideInfo[i] ?? "");
      });
    } else if (qr && qrWidth <= width && qrLines.length + info.length + 2 <= height) {
      header = [...qrLines, ...info.map(line => Array.from(line).slice(0, width).join(""))];
    } else {
      header = [qr ? "Enlarge terminal to display the full QR." : "QR unavailable; use the public link below.", ...info].flatMap(line => wrap(line, width));
    }
    header.push(...wrap(HELP, width));
    const available = Math.max(0, height - header.length - 1);
    if (available) header.push(...lines.slice(-available).map(line => Array.from(line).slice(0, width).join("")));
    header = header.slice(0, Math.max(0, height - 1));
    try { output.write(CLEAR + header.join("\n") + "\n"); } catch { stop("terminal-error"); }
  };
  const schedule = (): void => { if (!stopped && !scheduled) scheduled = setTimeout(render, 60); };
  const onData = (data: unknown): void => {
    const value = Buffer.isBuffer(data) ? data.toString("utf8") : typeof data === "string" ? data : "";
    if (value.includes("\u0003") || value.includes("\u0004") || value === "q") stop("quit");
    else if (value === "?") { help = !help; schedule(); }
    else if (value === "c" || value === "\u000c") schedule();
  };
  const onEnd = (): void => stop("input-ended");
  const onError = (): void => stop("terminal-error");
  const onAbort = (): void => stop("aborted");
  let observerDone = true;
  let watching: Promise<void> = Promise.resolve();
  let reason: TerminalSessionResult["reason"] = "terminal-error";
  try {
    input.setRawMode(true); input.resume();
    input.on("data", onData); input.on("end", onEnd); input.on("error", onError);
    output.on?.("resize", schedule);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    signals.on("SIGINT", onAbort); signals.on("SIGTERM", onAbort);
    output.write(ENTER_SCREEN); render();
    observerDone = false;
    watching = runTerminalWatch({
      ...(options.observer ? { observer: options.observer } : {}),
      runtimeOwnership: options.runtime.ownership,
      signal: control.signal,
      secrets,
      onStatus: state => { watch = state; schedule(); },
      onLine: line => { events++; lines.push(line); if (lines.length > 50) lines.shift(); schedule(); },
    }).finally(() => { observerDone = true; });
    reason = await exit;
  } catch { stop("terminal-error"); reason = "terminal-error"; }
  finally {
    stopped = true; control.abort(); if (scheduled) clearTimeout(scheduled);
    input.off("data", onData); input.off("end", onEnd); input.off("error", onError);
    output.off?.("resize", schedule); options.signal?.removeEventListener("abort", onAbort);
    signals.off("SIGINT", onAbort); signals.off("SIGTERM", onAbort);
    try { input.setRawMode(wasRaw); if (!wasFlowing) input.pause(); } catch { /* Terminal may have closed. */ }
    try { output.write(LEAVE_SCREEN + "Stopped viewing. Agent and runtime were not changed.\n"); } catch { /* Closed terminal. */ }
  }
  if (!observerDone) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([watching, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    if (timer) clearTimeout(timer);
  }
  return { reason, observedEvents: events, observerStopped: observerDone };
}
