import type { CodingAgent } from "../coding-agents.js";
import { platformPath } from "./shared.js";

const agent: CodingAgent =
  {
    id: "cursor",
    label: "Cursor",
    aliases: [],
    command: "cursor-agent",
    installedIf: (paths) => [platformPath(paths.platform).join(paths.home, ".cursor")],
    // Cursor cannot start a turn from an mcp.json entry, so Relay writes none
    // and drives Cursor over ACP instead (acp-bridge.ts).
    connect: { kind: "acp-bridge" },
    // `cursor-agent acp` is Cursor's ACP server over stdio (cursor.com/docs/cli/acp;
    // acpx alias `cursor -> cursor-agent acp`, _sources/.../acp-router/SKILL.md).
    start: {
      kind: "acp-bridge",
      command: "cursor-agent",
      args: ["acp"],
      prompt: "Answer Relay messages with Cursor from this folder?",
    },
    detectedAs: ["cursor", "cursor-cli"],
  };

export default agent;
