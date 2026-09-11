import type { CodingAgent } from "../coding-agents.js";
import { platformPath } from "./shared.js";

const agent: CodingAgent =
  {
    id: "cursor",
    label: "Cursor",
    aliases: [],
    installedIf: (paths) => [platformPath(paths.platform).join(paths.home, ".cursor")],
    // https://cursor.com/docs/context/mcp: "Create ~/.cursor/mcp.json in your home
    // directory for tools available everywhere"; entries live under `mcpServers`.
    connect: { kind: "mcp-file", file: (paths) => platformPath(paths.platform).join(paths.home, ".cursor", "mcp.json"), shape: "mcpServers" },
    detectedAs: ["cursor", "cursor-cli"],
  };

export default agent;
