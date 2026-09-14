import type { CodingAgent } from "./shared.js";
import { claudeConfigDir } from "./shared.js";

const agent: CodingAgent =
  {
    id: "claude-code",
    label: "Claude Code",
    aliases: ["claude", "claudecode"],
    command: "claude",
    installedIf: (paths) => [claudeConfigDir(paths.env, paths.home, paths.platform)],
    connect: { kind: "claude-plugin" },
    start: {
      kind: "command",
      command: "claude",
      args: ["--dangerously-load-development-channels", "plugin:relay@relay-messenger"],
      prompt: "Start Claude Code with Relay now?",
    },
    detectedAs: ["claude"],
  };

export default agent;
