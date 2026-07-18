#!/usr/bin/env node
/**
 * relayapp — bridge your local coding agent to Relay.
 *
 *   relayapp pair [--engine <preset>] [--name <device-name>]
 *   relayapp start [--engine <preset>] [--dir <path>]
 *   relayapp install-codex
 *   relayapp install-claude
 *   relayapp install-openclaw
 *   relayapp doctor
 *
 * Internal entrypoints (wired by install-codex): notify, mcp,
 * hook permission-request.
 */
import { PRODUCTION_ORIGIN, RelayClient } from "./api.js";
import { notifyCommand, permissionRequestHook } from "./codex.js";
import { doctor } from "./doctor.js";
import { AcpEngine } from "./engine/acp.js";
import { ENGINE_HELP, enginePermissionTimeoutMs } from "./engine/catalog.js";
import { installClaude, installCodex, installOpenClaw } from "./install.js";
import { parseFlags } from "./flags.js";
import { mcpServe } from "./mcp.js";
import { pair } from "./pair.js";
import { PermissionBroker } from "./permissions.js";
import { ReceiveLoop } from "./receive.js";
import {
  ApprovalStore,
  ConfigStore,
  resolveOwnerUserId,
  RuntimeLock,
  runtimeHomeForConfig,
  SessionStore,
  StateStore,
} from "./store.js";

const USAGE = `relayapp — bridge your local coding agent to Relay (https://relayapp.im)

  relayapp pair            pair this machine with the Relay app (QR + code)
  relayapp start           receive messages and drive the engine
      --engine <preset>       (default claude)
      presets: ${ENGINE_HELP}
      --dir <path>            working directory for engine sessions
  relayapp install-codex   wire Codex notify + phone approvals + MCP server
  relayapp install-claude  point at the Claude Code channel plugin
  relayapp install-openclaw install and configure the bundled OpenClaw plugin
  relayapp doctor          health checks

Docs: https://docs.relayapp.im/quickstart`;

async function main(): Promise<number> {
  const [command, ...restArgv] = process.argv.slice(2);
  const flags = parseFlags(restArgv);
  const log = (line: string) => console.error(`[relayapp] ${line}`);

  switch (command) {
    case "pair": {
      const origin = PRODUCTION_ORIGIN;
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
      const origin = config.api_origin;
      const client = new RelayClient(origin, config.agent_token);
      const runtimeHome = runtimeHomeForConfig(config);
      const runtimeLock = new RuntimeLock(runtimeHome);
      // Acquire before any state/session/approval object can read or rewrite
      // whole-file ledgers for this paired identity.
      runtimeLock.acquire();
      try {
        const state = new StateStore(runtimeHome);
        const sessions = new SessionStore(runtimeHome);
        const approvals = new ApprovalStore(runtimeHome);
        const engine = new AcpEngine(flags.engine, sessions, log);
        const broker = new PermissionBroker(
          client,
          approvals,
          enginePermissionTimeoutMs(flags.engine),
          log,
        );
        const loop = new ReceiveLoop(client, state, engine, broker, {
          ownerUserId,
          cwd: flags.dir ?? process.cwd(),
          log,
        });
        let shuttingDown: Promise<void> | undefined;
        const shutdown = () => {
          if (shuttingDown) return shuttingDown;
          shuttingDown = (async () => {
            log("shutting down…");
            loop.stop();
            // Dispose first: this rejects/aborts any live engine turn so settle()
            // cannot wait forever on a child process we intend to terminate.
            await engine.dispose();
            await loop.settle();
            runtimeLock.release();
            process.exit(0);
          })();
          return shuttingDown;
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        log(`bridge running: engine=${flags.engine} dir=${flags.dir ?? process.cwd()} api=${origin}`);
        try {
          await loop.run();
        } finally {
          // Fatal loop exits (409/401 throws) must not leave a detached engine
          // process group running without its bridge.
          loop.stop();
          await engine.dispose().catch(() => {});
        }
        return 0;
      } finally {
        runtimeLock.release();
      }
    }
    case "install-codex":
      installCodex();
      return 0;
    case "install-claude":
      installClaude();
      return 0;
    case "install-openclaw":
      installOpenClaw();
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
