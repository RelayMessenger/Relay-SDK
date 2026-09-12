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
    // loads it when the folder is trusted (codex-rs/core/src/config.rs). The
    // token stays in Relay's global profile store; the file names the profile.
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
