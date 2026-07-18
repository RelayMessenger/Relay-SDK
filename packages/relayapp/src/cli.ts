#!/usr/bin/env node
/**
 * relayapp — bridge your local coding agent to Relay.
 *
 *   relayapp pair [--staging] [--engine claude|codex|opencode] [--name <device-name>]
 *   relayapp start [--engine claude|codex|opencode] [--dir <path>] [--staging]
 *   relayapp install-codex
 *   relayapp install-claude
 *   relayapp doctor
 *
 * Internal entrypoints (wired by install-codex): notify, mcp,
 * hook permission-request.
 */
import { resolve } from "node:path";
import { PRODUCTION_ORIGIN, RelayClient, STAGING_ORIGIN } from "./api.js";
import { notifyCommand, permissionRequestHook } from "./codex.js";
import { doctor } from "./doctor.js";
import { AcpEngine } from "./engine/acp.js";
import { OpencodeEngine, opencodeServerFromEnv } from "./engine/opencode.js";
import { installClaude, installCodex } from "./install.js";
import { mcpServe } from "./mcp.js";
import { pair } from "./pair.js";
import { PermissionBroker } from "./permissions.js";
import { ReceiveLoop } from "./receive.js";
import { ApprovalStore, ConfigStore, resolveOwnerUserId, SessionStore, StateStore } from "./store.js";

interface Flags {
  staging: boolean;
  engine: "claude" | "codex" | "opencode";
  dir?: string;
  name?: string;
  rest: string[];
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { staging: false, engine: "claude", rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--staging") flags.staging = true;
    else if (arg === "--engine") {
      const value = argv[++i];
      if (value !== "claude" && value !== "codex" && value !== "opencode") {
        throw new Error(`--engine must be "claude", "codex", or "opencode", got ${value ?? "(nothing)"}`);
      }
      flags.engine = value;
    } else if (arg === "--dir") {
      const value = argv[++i];
      if (!value) throw new Error("--dir needs a path");
      flags.dir = resolve(value);
    } else if (arg === "--name") {
      const value = argv[++i];
      if (!value) throw new Error("--name needs a value");
      flags.name = value;
    } else flags.rest.push(arg);
  }
  return flags;
}

const USAGE = `relayapp — bridge your local coding agent to Relay (https://relayapp.im)

  relayapp pair            pair this machine with the Relay app (QR + code)
  relayapp start           receive messages and drive the engine
      --engine claude|codex|opencode   (default claude)
      --dir <path>            working directory for engine sessions
      --staging               use api.staging.relayapp.im
  relayapp install-codex   wire Codex notify + phone approvals + MCP server
  relayapp install-claude  point at the Claude Code channel plugin
  relayapp doctor          health checks

Docs: https://docs.relayapp.im/quickstart`;

async function main(): Promise<number> {
  const [command, ...restArgv] = process.argv.slice(2);
  const flags = parseFlags(restArgv);
  const log = (line: string) => console.error(`[relayapp] ${line}`);

  switch (command) {
    case "pair": {
      const origin = flags.staging ? STAGING_ORIGIN : PRODUCTION_ORIGIN;
      await pair({ origin, engine: flags.engine, deviceName: flags.name });
      return 0;
    }
    case "start": {
      const config = new ConfigStore().load();
      if (!config?.agent_token) {
        console.error("Not paired. Run `relayapp pair` first.");
        return 1;
      }
      const ownerUserId = resolveOwnerUserId(config); // fail closed without a pinned owner
      const origin = flags.staging ? STAGING_ORIGIN : config.api_origin;
      const client = new RelayClient(origin, config.agent_token);
      const state = new StateStore();
      const sessions = new SessionStore();
      const approvals = new ApprovalStore();
      const engine =
        flags.engine === "opencode"
          ? new OpencodeEngine(
              sessions,
              {
                server: opencodeServerFromEnv(
                  config.opencode
                    ? {
                        url: config.opencode.server_url,
                        username: config.opencode.username,
                        password: config.opencode.password,
                      }
                    : undefined,
                ),
              },
              log,
            )
          : new AcpEngine(flags.engine, sessions, log);
      const broker = new PermissionBroker(client, approvals, undefined, log);
      const loop = new ReceiveLoop(client, state, engine, broker, {
        ownerUserId,
        cwd: flags.dir ?? process.cwd(),
        log,
      });
      const shutdown = async () => {
        log("shutting down…");
        loop.stop();
        await loop.settle();
        await engine.dispose();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      log(`bridge running: engine=${flags.engine} dir=${flags.dir ?? process.cwd()} api=${origin}`);
      await loop.run();
      return 0;
    }
    case "install-codex":
      installCodex();
      return 0;
    case "install-claude":
      installClaude();
      return 0;
    case "doctor":
      return (await doctor()) ? 0 : 1;
    case "notify":
      await notifyCommand(restArgv);
      return 0;
    case "mcp":
      await mcpServe();
      return 0;
    case "hook": {
      if (flags.rest[0] !== "permission-request") {
        console.error(`unknown hook: ${flags.rest[0] ?? "(none)"}`);
        return 1;
      }
      return await permissionRequestHook();
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(USAGE);
      return 1;
  }
}

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error) => {
    console.error(`relayapp: ${error?.message ?? error}`);
    process.exitCode = 1;
  },
);
