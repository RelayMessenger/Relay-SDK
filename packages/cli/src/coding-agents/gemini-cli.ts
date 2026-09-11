import type { CodingAgent } from "../coding-agents.js";
import { platformPath } from "./shared.js";

const agent: CodingAgent =
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    aliases: ["gemini"],
    command: "gemini",
    installedIf: (paths) => [platformPath(paths.platform).join(paths.home, ".gemini")],
    // `gemini mcp add -s user` writes ~/.gemini/settings.json (Docker's registry, row `gemini`).
    connect: { kind: "mcp-command", file: (paths) => platformPath(paths.platform).join(paths.home, ".gemini", "settings.json") },
    detectedAs: ["gemini"],
  };

export default agent;
