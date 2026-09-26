import { describe, expect, it } from "vitest";
import {
  AGENT_TOKEN_ENV, HOSTED_MCP_URL, MCP_SERVER_NAME, STAGING_HOSTED_MCP_URL,
  claudeMcpServer, codexMcpServer, hostedMcpURL, mcpRemoteServer, vscodeMcpEntry,
} from "./hosted-mcp.js";

const mcp = { url: STAGING_HOSTED_MCP_URL, token: "rel_token_calm" };

describe("Relay's hosted MCP server", () => {
  it("is the root path of mcp.relayapp.im, and of the staging host for a staging build", () => {
    expect(HOSTED_MCP_URL).toBe("https://mcp.relayapp.im");
    expect(STAGING_HOSTED_MCP_URL).toBe("https://mcp.staging.relayapp.im");
    expect(hostedMcpURL("0.4.2")).toBe("https://mcp.relayapp.im");
    expect(hostedMcpURL("0.4.3-staging.7")).toBe("https://mcp.staging.relayapp.im");
    expect(MCP_SERVER_NAME).toBe("relay");
    expect(AGENT_TOKEN_ENV).toBe("RELAY_AGENT_TOKEN");
  });

  it("reaches Claude Code as the Agent SDK's McpHttpServerConfig", () => {
    expect(claudeMcpServer(mcp)).toStrictEqual({
      type: "http",
      url: "https://mcp.staging.relayapp.im",
      headers: { Authorization: "Bearer rel_token_calm" },
    });
  });

  it("reaches VS Code as servers.relay of type http with the Authorization header", () => {
    expect(vscodeMcpEntry(mcp)).toStrictEqual({
      type: "http",
      url: "https://mcp.staging.relayapp.im",
      headers: { Authorization: "Bearer rel_token_calm" },
    });
  });

  it("reaches Codex as url plus bearer_token_env_var, never the token", () => {
    expect(codexMcpServer(mcp.url)).toStrictEqual({
      url: "https://mcp.staging.relayapp.im",
      bearer_token_env_var: "RELAY_AGENT_TOKEN",
    });
  });

  it("reaches a stdio-only client through mcp-remote, the token in AUTH_HEADER and not on the command line", () => {
    const remote = mcpRemoteServer(mcp);
    expect(remote).toStrictEqual({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.staging.relayapp.im", "--header", "Authorization:${AUTH_HEADER}"],
      env: { AUTH_HEADER: "Bearer rel_token_calm" },
    });
    expect(remote.args.join(" ")).not.toContain(mcp.token);
  });
});
