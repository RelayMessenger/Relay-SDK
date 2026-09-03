#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { AuthContext } from "./auth.js";
import { collectLocalTokens, validateApiURL } from "./auth.js";
import { safeErrorMessage } from "./redact.js";
import { createRelayMcpServer } from "./server.js";

const usage = `Usage: relay-mcp [options]

Local MCP v2 stdio server for Relay.

Options:
  --profile <name>   Select a local Relay profile
  --api-url <url>    Override the Relay API origin (never an Agent Token)
  --version          Print package version
  --help             Print this help

Agent Tokens resolve from RELAY_AGENT_TOKEN or the local Relay profile file.
Remote HTTP and OAuth transports are not implemented.
`;

const parseArgs = (args: string[]): AuthContext | "help" | "version" => {
  const context: AuthContext = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--version" || argument === "-V") return "version";
    if (argument === "--profile") {
      const value = args[++index];
      if (!value) throw new Error("--profile requires a value.");
      context.profile = value;
      continue;
    }
    if (argument === "--api-url") {
      const value = args[++index];
      if (!value) throw new Error("--api-url requires a value.");
      context.apiURL = validateApiURL(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return context;
};

try {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(usage);
  } else if (parsed === "version") {
    process.stdout.write("0.1.0-staging.5\n");
  } else {
    serveStdio(
      () => createRelayMcpServer({ authContext: parsed }),
      {
        legacy: "serve",
        onerror: async (error) => {
          const secrets = await collectLocalTokens(parsed);
          process.stderr.write(`Relay MCP error: ${safeErrorMessage(error, secrets)}\n`);
        },
      },
    );
  }
} catch (error) {
  const secrets = await collectLocalTokens();
  process.stderr.write(`Relay MCP error: ${safeErrorMessage(error, secrets)}\n`);
  process.exitCode = 1;
}
