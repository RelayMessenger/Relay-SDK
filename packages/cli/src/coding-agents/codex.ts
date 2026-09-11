import type { CodingAgent } from "../coding-agents.js";
import { platformPath, codexHome } from "./shared.js";

const agent: CodingAgent =
  {
    id: "codex",
    label: "Codex",
    aliases: [],
    command: "codex",
    installedIf: (paths) => [codexHome(paths.env, paths.home, paths.platform)],
    // `codex mcp add` writes ~/.codex/config.toml (its own --config help names the file).
    connect: { kind: "mcp-command", file: (paths) => platformPath(paths.platform).join(codexHome(paths.env, paths.home, paths.platform), "config.toml") },
    start: {
      kind: "command",
      command: "codex",
      args: [],
      prompt: "Start Codex with Relay now?",
    },
    detectedAs: ["codex"],
  };

export default agent;
