import type { AgentPaths, CodingAgent } from "../coding-agents.js";
import { platformPath } from "./shared.js";

/**
 * The MCP settings file Cline reads, resolved the way Cline resolves it
 * (cline 3.0.65, sdk/packages/shared/src/storage/paths.ts,
 * `resolveMcpSettingsPath`): `CLINE_MCP_SETTINGS_PATH`, else
 * `<data>/settings/cline_mcp_settings.json`, where the data folder is
 * `CLINE_DATA_DIR`, else `<CLINE_DIR or ~/.cline>/data`. Cline trims each
 * variable and ignores an empty one. A relative path is read from the folder
 * Cline runs in, which is the folder connect runs in.
 */
export const clineMcpSettings = (paths: AgentPaths): string => {
  const path = platformPath(paths.platform);
  const explicit = paths.env.CLINE_MCP_SETTINGS_PATH?.trim();
  if (explicit) return path.resolve(paths.cwd, explicit);
  const data = paths.env.CLINE_DATA_DIR?.trim()
    || path.join(paths.env.CLINE_DIR?.trim() || path.join(paths.home, ".cline"), "data");
  return path.join(data, "settings", "cline_mcp_settings.json");
};

const agent: CodingAgent =
  {
    id: "cline",
    label: "Cline",
    aliases: [],
    command: "cline",
    installedIf: (paths) => [platformPath(paths.platform).join(paths.home, ".cline")],
    // Relay drives Cline over ACP (acp-bridge.ts), but Cline stores the
    // `mcpServers` a `session/new` hands it and never reads them
    // (apps/cli/src/acp/acpAgent.ts, `newSession`). Every Cline session loads
    // the servers in its MCP settings file instead
    // (sdk/packages/core/src/runtime/orchestration/runtime-builder.ts,
    // `loadConfiguredMcpTools`), so Relay adds its server there.
    connect: { kind: "acp-bridge", mcpSettings: clineMcpSettings },
    // `cline --acp` is Cline's ACP server over stdio, spawned by the client:
    // "ACP mode is started with the `--acp` flag" (https://docs.cline.bot/usage/acp).
    start: {
      kind: "acp-bridge",
      command: "cline",
      args: ["--acp"],
      prompt: "Answer Relay messages with Cline from this folder?",
      // Over ACP "every file edit and command goes through the client's
      // permission UI", and `--auto-approve` sets that at launch (Cline docs,
      // usage/acp, "Auto-approving tools"; _sources/
      // unattended-agent-permissions-20260926/cline-docs-usage-acp.mdx.txt:103-106).
      // `false` pins the default, so a changed default cannot approve commands
      // by itself (cline 3.0.65 starts ACP with
      // `autoApproveTools: autoApproveOverride === true`;
      // _sources/connect-safety-20260926/cline-cli-3.0.65-binary-excerpts.txt).
      noCommands: { args: ["--auto-approve", "false"] },
    },
    detectedAs: [],
    // Over ACP, Cline refuses a session until it is signed in: credentials
    // saved by `cline auth`, or `CLINE_API_KEY` (acpAgent.ts, `isSessionReady`;
    // docs.cline.bot/usage/acp, "Prerequisites" and "Environment variables").
    signIn: "Cline needs its own sign-in to answer: run cline auth once, or set CLINE_API_KEY.",
  };

export default agent;
