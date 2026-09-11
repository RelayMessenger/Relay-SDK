import type { CodingAgent } from "../coding-agents.js";
import { platformPath } from "./shared.js";

const agent: CodingAgent =
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    aliases: ["gemini"],
    command: "gemini",
    installedIf: (paths) => [platformPath(paths.platform).join(paths.home, ".gemini")],
    // Gemini CLI cannot start a turn from a settings.json MCP entry, so Relay
    // writes none and drives it over ACP instead (acp-bridge.ts).
    connect: { kind: "acp-bridge" },
    // `gemini --experimental-acp` runs Gemini CLI in ACP mode over stdio; Gemini
    // CLI was Zed's first reference ACP agent (zed.dev/acp/agent/gemini-cli,
    // _sources/host-connect-docs/gemini-cli/NOTES.md).
    start: {
      kind: "acp-bridge",
      command: "gemini",
      args: ["--experimental-acp"],
      prompt: "Answer Relay messages with Gemini CLI from this folder?",
    },
    detectedAs: ["gemini"],
  };

export default agent;
