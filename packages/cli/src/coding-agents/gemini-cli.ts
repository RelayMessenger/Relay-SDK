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
    // `--skip-trust` trusts the folder for this run only. Gemini CLI connects no
    // MCP server in a folder it does not trust, the ones a client hands its ACP
    // session included, and the bridge has no terminal for its trust dialog.
    // Gemini documents the flag for exactly this: "When running Gemini CLI in a
    // headless environment ... bypass the trust check using ... the
    // `--skip-trust` flag" (docs/cli/trusted-folders.md, "Headless and
    // automated environments"; docs/cli/cli-reference.md; saved under
    // _sources/network-20260926/mcp-xos/). The person chose the folder by
    // running connect in it; nothing is written to ~/.gemini/trustedFolders.json.
    start: {
      kind: "acp-bridge",
      command: "gemini",
      args: ["--experimental-acp", "--skip-trust"],
      prompt: "Answer Relay messages with Gemini CLI from this folder?",
    },
    detectedAs: ["gemini"],
  };

export default agent;
