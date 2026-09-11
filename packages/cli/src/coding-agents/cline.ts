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
    // TODO(cline-acp): Cline's ACP entry command is not confirmed from any
    // source. Cline's docs say it can act "as a coding agent in other clients"
    // over ACP (_sources/host-connect-docs/cline/NOTES.md) and the ACP registry
    // lists Cline (acp/docs/get-started/agents.mdx), but neither gives the exact
    // launch flag, and Cline is absent from the acpx alias table. So `args` is
    // left off: connect wires Cline to the bridge but does not start it until
    // the flag is confirmed, rather than guessing one.
    start: {
      kind: "acp-bridge",
      command: "cline",
      prompt: "Answer Relay messages with Cline from this folder?",
    },
    detectedAs: [],
  };

export default agent;
