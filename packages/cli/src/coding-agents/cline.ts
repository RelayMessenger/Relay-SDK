import type { CodingAgent } from "../coding-agents.js";
import { platformPath } from "./shared.js";

const agent: CodingAgent =
  {
    id: "cline",
    label: "Cline",
    aliases: [],
    command: "cline",
    installedIf: (paths) => [platformPath(paths.platform).join(paths.home, ".cline")],
    // `cline mcp add --yes <name> -- <command>` writes the CLI's own
    // ~/.cline/data/settings/cline_mcp_settings.json (measured 2026-09-10 in the
    // lane sandbox, cline 3.0.61); its entry shape is Cline's, so Cline writes it.
    connect: { kind: "mcp-command", file: (paths) => platformPath(paths.platform).join(paths.home, ".cline", "data", "settings", "cline_mcp_settings.json") },
    start: { kind: "restart", instruction: "Restart your editor so Cline loads Relay, then ask Cline to read your Relay messages." },
    detectedAs: [],
  };

export default agent;
