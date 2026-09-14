import type { CodingAgent } from "../coding-agents.js";
import { platformPath, configHome } from "./shared.js";

const agent: CodingAgent =
  {
    id: "opencode",
    label: "OpenCode",
    aliases: [],
    command: "opencode",
    installedIf: (paths) => [platformPath(paths.platform).join(configHome(paths), "opencode")],
    // OpenCode cannot start a turn from an opencode.json MCP entry, so Relay
    // writes none and drives it over ACP instead (acp-bridge.ts).
    connect: { kind: "acp-bridge" },
    // `opencode acp` is OpenCode's native ACP server over stdio; the ACP
    // registry resolves `opencode -> "opencode acp"`
    // (_sources/native-connect/openclaw/extensions/acpx/src/runtime.test.ts).
    // OpenCode also has an HTTP `opencode serve` + `@opencode-ai/sdk` path
    // (Inkbox opencode-plugin/src/gateway/sessions.ts:238); the ACP command is
    // used so all four targets share one bridge and one protocol.
    start: {
      kind: "acp-bridge",
      command: "opencode",
      args: ["acp"],
      prompt: "Answer Relay messages with OpenCode from this folder?",
    },
    detectedAs: ["opencode"],
  };

export default agent;
