import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Relay from "@relaymessenger/sdk";
import { RELAY_CHAT_ID_ENV, runPiChannel } from "./index.js";
import { relayTools } from "./tools.js";
import { registerRelayAdapter, relayChannelAdapter, RELAY_ADAPTER } from "./pi-channels.js";
import { SessionChannel } from "./session.js";
import { transcribeCpp } from "./voice.js";

let controller: AbortController | undefined;
let running: Promise<void> | undefined;

/**
 * The `relay` key of Pi's global settings.json. With `mode: "session"` Relay
 * runs inside the Pi session that loads this extension; otherwise the
 * commands below start a separate Pi per chat, as before.
 */
export interface RelaySettings {
  readonly mode?: "channel" | "session";
  /** A command that prints the Agent Token, read when RELAY_AGENT_TOKEN is unset. */
  readonly agentTokenCommand?: readonly string[];
  readonly baseURL?: string;
  /** Handles whose Messages reach the session; any sender when absent. */
  readonly senders?: readonly string[];
  /** Voice notes heard with transcribe-cpp: its installed package and a model it loads. */
  readonly transcribeCpp?: { readonly module: string; readonly model: string };
}

const home = (path: string): string => path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
const agentDir = (): string => home(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"));

/** The `relay` settings, or none when the file or key is missing or unreadable. */
export const relaySettings = async (dir = agentDir()): Promise<RelaySettings> => {
  try {
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as { relay?: unknown };
    return settings.relay && typeof settings.relay === "object" ? settings.relay as RelaySettings : {};
  } catch {
    return {};
  }
};

/**
 * The `relay` key of the `pi-channels` settings, beside pi-channels' own
 * `slack` key: global settings.json, then the project's .pi/settings.json
 * over it, as pi-channels merges its settings. None when absent.
 */
export const piChannelsRelaySettings = async (cwd: string, dir = agentDir()): Promise<RelaySettings | undefined> => {
  const read = async (file: string): Promise<RelaySettings | undefined> => {
    try {
      const value = (JSON.parse(await readFile(file, "utf8")) as { "pi-channels"?: { relay?: unknown } })["pi-channels"]?.relay;
      return value && typeof value === "object" ? value as RelaySettings : undefined;
    } catch {
      return undefined;
    }
  };
  const global = await read(join(dir, "settings.json"));
  const project = await read(join(cwd, ".pi", "settings.json"));
  return global || project ? { ...global, ...project } : undefined;
};

/** RELAY_AGENT_TOKEN, else what `agentTokenCommand` prints; never logged. */
export const agentToken = async (settings: RelaySettings): Promise<string | undefined> => {
  const env = process.env.RELAY_AGENT_TOKEN?.trim();
  if (env) return env;
  const [command, ...args] = settings.agentTokenCommand ?? [];
  if (!command) return undefined;
  return new Promise((done) => {
    execFile(command, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => done(error ? undefined : stdout.trim() || undefined));
  });
};

const sessionMode = (settings: RelaySettings): boolean => (process.env.RELAY_PI_MODE?.trim() || settings.mode) === "session";

/** Relay inside this session, started once per process on its first session_start. */
const attachSession = (pi: ExtensionAPI): void => {
  let channel: SessionChannel | undefined;
  let stop: AbortController | undefined;
  pi.on("session_start", async (_event, ctx) => {
    // Only the RPC session an app drives: a terminal Pi on the same account
    // would hold a second connection on the same token, a print or JSON run
    // ends with its prompt, and a pi-subagents helper is not the session the
    // person talks to.
    if (stop || ctx.mode !== "rpc" || process.env.PI_SUBAGENT_CHILD === "1") return;
    const settings = await relaySettings();
    if (!sessionMode(settings)) return;
    const token = await agentToken(settings);
    if (!token) {
      console.error("Relay: no Agent Token (RELAY_AGENT_TOKEN or relay.agentTokenCommand); the session channel is off.");
      return;
    }
    const baseURL = process.env.RELAY_BASE_URL?.trim() || settings.baseURL;
    const senders = process.env.RELAY_SENDERS?.split(",").map((sender) => sender.trim()).filter(Boolean) ?? settings.senders;
    const voice = settings.transcribeCpp;
    stop = new AbortController();
    const relay = new Relay({ apiKey: token, ...(baseURL ? { baseURL } : {}) });
    channel = new SessionChannel(pi, {
      agentToken: token,
      relay,
      isIdle: () => ctx.isIdle(),
      lastChatFile: join(agentDir(), "relay-last-chat.json"),
      ...(baseURL ? { baseURL } : {}),
      ...(senders ? { senders } : {}),
      ...(voice ? { transcribe: transcribeCpp({ module: home(voice.module), model: home(voice.model) }) } : {}),
    });
    const current = channel;
    registerRelayTools(pi, relay, () => current.chatId);
    void channel.run(stop.signal).catch((error: unknown) => {
      console.error(`Relay: the session channel stopped: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  pi.on("agent_end", async (event) => { channel?.ended(event.messages); });
  pi.on("agent_settled", async () => { await channel?.settled(); });
  pi.on("session_shutdown", async () => {
    stop?.abort();
    channel?.stop();
    stop = undefined;
    channel = undefined;
  });
};

/**
 * Relay as a pi-channels adapter, registered with `channel:register` when
 * pi-channels is loaded and its settings have a `relay` key. It registers on
 * `resources_discover`, which Pi fires after every `session_start` handler,
 * because pi-channels' `session_start` drops adapters registered before it.
 */
const attachPiChannels = (pi: ExtensionAPI): void => {
  pi.on("resources_discover", async (event) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    const settings = await piChannelsRelaySettings(event.cwd);
    if (!settings) return;
    const token = await agentToken(settings);
    if (!token) {
      console.error("Relay: no Agent Token (RELAY_AGENT_TOKEN or pi-channels.relay.agentTokenCommand); the pi-channels adapter is off.");
      return;
    }
    const baseURL = process.env.RELAY_BASE_URL?.trim() || settings.baseURL;
    const voice = settings.transcribeCpp;
    registerRelayAdapter(pi.events, () => relayChannelAdapter({
      relay: new Relay({ apiKey: token, ...(baseURL ? { baseURL } : {}) }),
      ...(settings.senders ? { senders: settings.senders } : {}),
      ...(voice ? { transcribe: transcribeCpp({ module: home(voice.module), model: home(voice.model) }) } : {}),
    }), RELAY_ADAPTER);
  });
};

/** The Relay tools, as Pi registers a tool (docs/extensions.md, registerTool). */
const registerRelayTools = (pi: ExtensionAPI, relay: Relay, chatId: () => string | undefined): void => {
  for (const tool of relayTools(relay, chatId)) pi.registerTool(tool as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
};

/**
 * The Pi that `runPiChannel` starts for one chat: its environment names the
 * chat and carries the token, so it gets the Relay tools for that chat.
 */
const attachChatTools = (pi: ExtensionAPI): void => {
  const chatId = process.env[RELAY_CHAT_ID_ENV]?.trim();
  const token = process.env.RELAY_AGENT_TOKEN?.trim();
  if (!chatId || !token) return;
  const baseURL = process.env.RELAY_BASE_URL?.trim();
  registerRelayTools(pi, new Relay({ apiKey: token, ...(baseURL ? { baseURL } : {}) }), () => chatId);
};

/**
 * Pi-native entry point. By default it exposes only lifecycle-safe commands,
 * and Relay ingress is owned by runPiChannel so the CLI and extension share
 * the same authenticated routing implementation. With `relay.mode: "session"`
 * (or RELAY_PI_MODE=session) Messages come into this session instead.
 */
export default function relayPiExtension(pi: ExtensionAPI): void {
  attachChatTools(pi);
  attachSession(pi);
  attachPiChannels(pi);
  pi.registerCommand("relay-connect", {
    description: "Start the Relay channel using the configured Agent Token",
    handler: async (_args, ctx) => {
      if (running) {
        ctx.ui.notify("Relay Pi channel is already running.", "info");
        return;
      }
      const agentToken = process.env.RELAY_AGENT_TOKEN?.trim();
      if (!agentToken) {
        ctx.ui.notify("RELAY_AGENT_TOKEN is not configured.", "error");
        return;
      }
      controller = new AbortController();
      running = runPiChannel({
        agentToken,
        ...(process.env.RELAY_BASE_URL?.trim()
          ? { baseURL: process.env.RELAY_BASE_URL.trim() }
          : {}),
      }, controller.signal).catch((error: unknown) => {
        ctx.ui.notify(`Relay Pi channel stopped: ${error instanceof Error ? error.message : String(error)}`, "error");
      }).finally(() => {
        running = undefined;
        controller = undefined;
      });
      ctx.ui.notify("Relay Pi channel started.", "info");
    },
  });
  pi.registerCommand("relay-disconnect", {
    description: "Stop the Relay channel started by the Relay CLI",
    handler: async (_args, ctx) => {
      controller?.abort();
      ctx.ui.notify("Relay Pi channel stopping.", "info");
    },
  });
}
