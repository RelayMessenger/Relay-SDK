import type { CodingAgent } from "../coding-agents.js";
import { platformPath, codexHome } from "./shared.js";

const agent: CodingAgent =
  {
    id: "codex",
    label: "Codex",
    aliases: [],
    command: "codex",
    installedIf: (paths) => [codexHome(paths.env, paths.home, paths.platform)],
    // The folder's own `.codex/config.toml` is Codex's project layer; Codex
    // loads it only once the folder is trusted (codex-rs/core/src/config.rs),
    // so it serves Codex run by hand in a trusted folder. It names Relay's
    // hosted server and the RELAY_AGENT_TOKEN variable, never the token itself
    // (hosted-mcp.ts, `codexMcpServer`). The bridge does not depend on it: it
    // hands the same server to every thread it opens (codex-bridge.ts,
    // `codexThreadConfig`).
    connect: { kind: "codex-project", file: (paths) => platformPath(paths.platform).join(paths.cwd, ".codex", "config.toml") },
    // Codex has no long-lived process that Relay can push a message into, so
    // connect stays running and answers over `codex app-server` (codex-bridge.ts).
    start: {
      kind: "bridge",
      command: "codex",
      prompt: "Answer Relay messages with Codex from this folder?",
    },
    detectedAs: ["codex"],
  };

export default agent;
