import type { CodingAgent } from "./shared.js";
import { claudeConfigDir } from "./shared.js";

const agent: CodingAgent =
  {
    id: "claude-code",
    label: "Claude Code",
    aliases: ["claude", "claudecode"],
    command: "claude",
    installedIf: (paths) => [claudeConfigDir(paths.env, paths.home, paths.platform)],
    connect: { kind: "claude-bridge" },
    start: {
      kind: "claude-bridge",
      command: "claude",
      prompt: "Answer Relay messages with Claude Code from this folder?",
    },
    detectedAs: ["claude"],
  };

export default agent;
