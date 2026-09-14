import type { CodingAgent } from "../coding-agents.js";
import { platformPath } from "./shared.js";

const agent: CodingAgent =
  {
    id: "cline",
    label: "Cline",
    aliases: [],
    command: "cline",
    installedIf: (paths) => [platformPath(paths.platform).join(paths.home, ".cline")],
    // Cline cannot start a turn from its cline_mcp_settings.json entry, so Relay
    // writes none and drives it over ACP instead (acp-bridge.ts).
    connect: { kind: "acp-bridge" },
    // `cline --acp` is Cline's ACP server over stdio, spawned by the client:
    // "ACP mode is started with the `--acp` flag" (https://docs.cline.bot/usage/acp).
    start: {
      kind: "acp-bridge",
      command: "cline",
      args: ["--acp"],
      prompt: "Answer Relay messages with Cline from this folder?",
    },
    detectedAs: [],
  };

export default agent;
