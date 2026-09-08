import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { stripVTControlCharacters } from "node:util";
import { redactText } from "./output.js";

export type TerminalWatchStatus = "connecting" | "ready" | "disconnected" | "unavailable" | "gap";
export type TerminalRuntimeOwnership = "none" | "external" | "unknown";

/** The read-only view Relay offers. Never pass off the reading-and-taking connection as this. */
export interface TerminalObserver {
  readonly semantics: "observational-no-ack";
  run(input: {
    signal: AbortSignal;
    onStatus(status: TerminalWatchStatus): void;
    onEvent(event: RelayWebhookEvent): void;
  }): Promise<void>;
}
export interface TerminalWatchInput {
  observer?: TerminalObserver;
  runtimeOwnership: TerminalRuntimeOwnership;
  signal: AbortSignal;
  secrets?: readonly string[];
  onStatus(status: TerminalWatchStatus): void;
  onLine(line: string): void;
}

/** Single-line terminal output: never interpret event/metadata escape sequences or token values. */
export function terminalText(value: unknown, secrets: readonly string[] = [], limit = 240): string {
  if (typeof value !== "string") return "";
  const redacted = redactText(value, secrets).replace(/rly_live_[A-Za-z0-9]{43}/gu, "[REDACTED]");
  return stripVTControlCharacters(redacted)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ").trim().slice(0, limit);
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function terminalEventLine(event: RelayWebhookEvent, secrets: readonly string[] = []): string {
  const row = object(event);
  const data = object(row.data);
  const actor = object(data.sender_handle).handle ?? object(data.contact).handle;
  const parts = Array.isArray(data.parts) ? data.parts : [];
  const text = parts.map(object).filter(part => part.type === "text" && typeof part.value === "string")
    .map(part => part.value).join(" ");
  const kind = terminalText(row.event_type, secrets, 64) || "event";
  const sender = terminalText(actor, secrets, 72);
  const message = terminalText(text, secrets, 200);
  const id = terminalText(row.event_id, secrets, 48);
  return `${kind}${sender ? ` @${sender}` : ""}${message ? ` — ${message}` : id ? ` · ${id}` : ""}`;
}

/** Watch only. Nothing here creates an SDK client, a route, a timer, a reply to Relay, or any control over a runtime. */
export async function runTerminalWatch(input: TerminalWatchInput): Promise<void> {
  if (input.signal.aborted) return;
  if (!input.observer || input.observer.semantics !== "observational-no-ack") {
    input.onStatus("unavailable");
    return;
  }
  const emitStatus = (status: TerminalWatchStatus): void => {
    if (!input.signal.aborted && ["connecting", "ready", "disconnected", "unavailable", "gap"].includes(status)) input.onStatus(status);
  };
  emitStatus("connecting");
  try {
    await input.observer.run({
      signal: input.signal,
      onStatus: emitStatus,
      onEvent: event => { if (!input.signal.aborted) input.onLine(terminalEventLine(event, input.secrets)); },
    });
    if (!input.signal.aborted) emitStatus("disconnected");
  } catch {
    // Raw errors can hold tokens or headers; never turn them into text.
    emitStatus("unavailable");
  }
}

/** Uses the SDK's watch-only mode. It never falls back to the connection that takes events. */
export function sdkTerminalObserver(client: Pick<import("@relaymessenger/sdk").default, "websocket">): TerminalObserver {
  return {
    semantics: "observational-no-ack",
    async run(input) {
      await client.websocket.run({
        signal: input.signal,
        observe: true,
        onConnectionState: state => input.onStatus(state === "ready" ? "ready" : state),
        onReady: frame => { if (frame.observational !== true) input.onStatus("unavailable"); },
        onObservationGap: () => input.onStatus("gap"),
        onEvent: async event => { input.onEvent(event); },
        onFullSync: async () => { throw new Error("Observation must not complete FULL sync."); },
        onError: () => input.onStatus("disconnected"),
      });
    },
  };
}
