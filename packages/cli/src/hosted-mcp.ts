import { DEFAULT_API_URL, STAGING_API_URL, isStagingBuild, packageVersion } from "./config.js";

/**
 * Relay has one MCP server, and it is hosted: the local `@relaymessenger/mcp`
 * package is retired (Relay-SDK PR 357). The server answers at the root path,
 * not `/mcp`, and takes an Agent Token as `Authorization: Bearer <token>`,
 * acting as that agent (Relay-Server PR 393). A staging build points at the
 * staging server, the way it takes the staging API (config.ts, `isStagingBuild`).
 */
export const HOSTED_MCP_URL = "https://mcp.relayapp.im";
export const STAGING_HOSTED_MCP_URL = "https://mcp.staging.relayapp.im";
export const hostedMcpURL = (version: string = packageVersion()): string =>
  isStagingBuild(version) ? STAGING_HOSTED_MCP_URL : HOSTED_MCP_URL;

/**
 * The hosted server of the environment the agent lives in. An Agent Token is
 * valid only on the API that issued it, so the server that acts as the agent
 * is the one beside that API: the staging API's agents use the staging
 * server and production's use production, whichever build of the CLI runs
 * (`--api-url` or RELAY_API_URL can pick either). An API address that is
 * neither, a local or custom server, keeps the build's own server.
 */
export const hostedMcpURLFor = (apiURL: string | undefined, version: string = packageVersion()): string => {
  const host = apiURL ? new URL(apiURL).host : undefined;
  if (host === new URL(STAGING_API_URL).host) return STAGING_HOSTED_MCP_URL;
  if (host === new URL(DEFAULT_API_URL).host) return HOSTED_MCP_URL;
  return hostedMcpURL(version);
};

/** The name every agent lists the server under. */
export const MCP_SERVER_NAME = "relay";

/**
 * The variable a client reads the Agent Token from when its config file must
 * not hold the token itself. The same name Relay-Docs integrations/mcp.mdx
 * gives every client (Relay-Docs PR 227).
 */
export const AGENT_TOKEN_ENV = "RELAY_AGENT_TOKEN";

/**
 * The hosted server's write tools: each acts as the agent, and other people
 * and agents see the result. The rows after "Write tools act as your agent"
 * in Relay-Docs integrations/mcp.mdx ("What it can do", PR 227), less the
 * community feed's post, comment and upvote tools, removed with the feed.
 */
export const RELAY_WRITE_TOOLS = ["send_message", "send_task", "update_task"] as const;

/** The hosted server as one agent reaches it. */
export interface HostedMcp {
  url: string;
  token: string;
}

const bearer = (token: string): string => `Bearer ${token}`;

/**
 * Claude Code through the Agent SDK: `McpHttpServerConfig`, `{ type: "http",
 * url, headers }` (@anthropic-ai/claude-agent-sdk 0.3.278, sdk.d.ts). The same
 * server `claude mcp add --transport http relay <url> --header "Authorization:
 * Bearer $RELAY_AGENT_TOKEN"` adds (Relay-Docs PR 227, integrations/mcp.mdx,
 * Claude Code tab). The entry lives in memory for the session; no file holds it.
 */
export const claudeMcpServer = (mcp: HostedMcp): { type: "http"; url: string; headers: Record<string, string> } => ({
  type: "http",
  url: mcp.url,
  headers: { Authorization: bearer(mcp.token) },
});

/**
 * VS Code's user `mcp.json`, `servers.relay`: `type: "http"`, `url`, and
 * `headers` `{ "Authorization": "Bearer …" }`
 * (code.visualstudio.com/docs/copilot/reference/mcp-configuration, "HTTP and
 * Server-Sent Events (SSE) servers" table; saved at
 * _sources/mcp-hosted-docs-20260926/vscode-mcp-configuration.txt:1590-1615).
 * Relay-Docs PR 227 fills the header from a `${input:…}` prompt for a person
 * typing it; connect already holds the token, so it writes the value itself.
 */
export const vscodeMcpEntry = (mcp: HostedMcp): { type: "http"; url: string; headers: Record<string, string> } => ({
  type: "http",
  url: mcp.url,
  headers: { Authorization: bearer(mcp.token) },
});

/**
 * Cline's `mcpServers.relay`: `type: "streamableHttp"`, `url`, and `headers`
 * with a static `Authorization` (docs.cline.bot/mcp/mcp-overview, "Remote
 * server (Streamable HTTP)"; cline 3.0.65, sdk/packages/core/src/extensions/mcp/
 * config-loader.ts, the URL registration schema; client.ts,
 * `hasStaticAuthorizationHeader`). Cline expands no variables in a header, so
 * the value is the token itself; the file lives in Cline's own data folder,
 * outside the project, written owner-only. Saved at _sources/cline-mcp-20260926/.
 */
export const clineMcpEntry = (mcp: HostedMcp): { type: "streamableHttp"; url: string; headers: Record<string, string> } => ({
  type: "streamableHttp",
  url: mcp.url,
  headers: { Authorization: bearer(mcp.token) },
});

/**
 * Codex's `[mcp_servers.relay]` for a streamable HTTP server: `url` and
 * `bearer_token_env_var`, byte for byte what `codex mcp add relay --url <url>
 * --bearer-token-env-var RELAY_AGENT_TOKEN` writes (codex-cli 0.155.1,
 * _sources/mcp-hosted-docs-20260926/codex-mcp-add-url-config.txt), and the
 * Agent Token variant Relay-Docs PR 227 gives Codex. The file sits in the
 * project folder, so it names the variable and never holds the token; the
 * Codex bridge hands the variable to `codex app-server` (codex-bridge.ts).
 */
export const codexMcpServer = (url: string): { url: string; bearer_token_env_var: string } => ({
  url,
  bearer_token_env_var: AGENT_TOKEN_ENV,
});

/**
 * A client with no remote transport runs the hosted server through
 * `mcp-remote`, as Relay-Docs PR 227 ("Clients without remote support") and
 * the mcp-remote README give it: `npx -y mcp-remote <url> --header
 * Authorization:${AUTH_HEADER}`, the value in `AUTH_HEADER`, with no space
 * around the colon so no client splits the argument
 * (_sources/mcp-hosted-docs-20260926/mcp-remote-README.md:56-70).
 */
export const mcpRemoteServer = (mcp: HostedMcp): { command: string; args: string[]; env: Record<string, string> } => ({
  command: "npx",
  args: ["-y", "mcp-remote", mcp.url, "--header", "Authorization:${AUTH_HEADER}"],
  env: { AUTH_HEADER: bearer(mcp.token) },
});
