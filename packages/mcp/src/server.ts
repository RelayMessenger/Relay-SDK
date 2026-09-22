import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import Relay, { BUTTONS_GUIDANCE, INVOICE_GUIDANCE, SELECTION_GUIDANCE } from "@relaymessenger/sdk";
import { z } from "zod";
import type { AuthContext } from "./auth.js";
import { collectLocalTokens, resolveAgentAuth } from "./auth.js";
import { searchDocs } from "./search-docs.js";
import { executeCode, type ExecutionLimits } from "./execute.js";
import { redact, safeErrorMessage } from "./redact.js";
import pkg from "../package.json" with { type: "json" };

export const PACKAGE_VERSION: string = pkg.version;
export interface ResolvedRelayClient { client: Relay; secrets?: string[] }
export interface RelayMcpServerOptions {
  authContext?: AuthContext;
  resolveClient?: () => Promise<ResolvedRelayClient>;
  collectSecrets?: () => Promise<string[]>;
  executionLimits?: Partial<ExecutionLimits>;
}

export const createRelayMcpServer = (options: RelayMcpServerOptions = {}): McpServer => {
  const context = options.authContext ?? {};
  const collectSecrets = options.collectSecrets ?? (() => collectLocalTokens(context));
  const resolveClient = options.resolveClient ?? (async () => {
    const auth = await resolveAgentAuth(context);
    return { client: new Relay({ apiKey: auth.token, baseURL: auth.apiURL }), secrets: [auth.token] };
  });
  const server = new McpServer({ name: "relay", version: PACKAGE_VERSION }, {
    capabilities: { tools: {} },
    instructions: "Use search_docs to find Relay SDK methods, then execute to call them. "
      + "Agent authentication is resolved locally, never supplied in tool arguments. "
      + "execute can change the authenticated account; reuse stable idempotency keys for message sends.",
  });
  server.registerTool("search_docs", {
    title: "Search Relay SDK documentation",
    description: "Search the packaged Relay SDK method and contract documentation for signatures, parameters, and examples before writing code.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(2_000),
      language: z.enum(["typescript", "javascript", "http"]).default("typescript"),
      detail: z.enum(["default", "verbose"]).default("default"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input): Promise<CallToolResult> => {
    const result = searchDocs(input);
    let secrets: string[] = [];
    try { secrets = await collectSecrets(); } catch { /* Public docs remain available without valid local configuration. */ }
    const text = redact(JSON.stringify(result, null, 2), secrets);
    return { content: [{ type: "text", text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
  });
  server.registerTool("execute", {
    title: "Execute Relay SDK code",
    description: "Run TypeScript or JavaScript defining async function run(client), using the initialized Relay SDK HTTP resource methods. "
      + "Returns the function result and console output. Each call has a fresh, bounded JavaScript runtime; "
      + "no shell, filesystem, environment variables, imports, or arbitrary network access are provided. "
      + "Only SDK calls reach the configured Relay API. SDK credentials stay outside submitted code. "
      + "HTTP results and arguments are JSON values; live WebSocket callbacks and raw uploads are not part of this runtime. "
      + "A message's parts may include one buttons part ({ type: \"buttons\", items: [{ label }, { label, url }] }, 1 to 5 items) beside a text part; "
      + "search_docs(\"buttons\") shows the shape. "
      + "A link is its own message whose only part is { type: \"link\", value: \"https://...\" }, drawn as a card; send the words first, then the link. "
      + BUTTONS_GUIDANCE + " " + SELECTION_GUIDANCE + " " + INVOICE_GUIDANCE
      + ' A selection part is { type: "selection", options: [{ value: "research", label: "Research" }] }. Search selection with detail verbose for types. Incoming selection_response.selected_values and reply_to remain in Message parts and events.'
      + ' An invoice part is { type: "invoice", title, amount, currency, goods: "physical" | "digital", url, recurring? } and must be the only part of its message; '
      + "search_docs(\"invoice\") shows the shape. Update its status with client.messages.invoice.update(messageId, { status }).",
    inputSchema: z.object({ code: z.string().min(1).max(100_000), intent: z.string().max(2_000).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ code }): Promise<CallToolResult> => {
    let secrets: string[] = [];
    try {
      try { secrets = await collectSecrets(); } catch { /* The resolver reports invalid configuration. */ }
      const resolved = await resolveClient();
      secrets.push(...(resolved.secrets ?? []));
      const result = await executeCode(code, resolved.client, secrets, options.executionLimits);
      const text = redact(JSON.stringify(result), secrets);
      return { content: [{ type: "text", text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
    } catch (error) {
      return { content: [{ type: "text", text: `Relay execution failed: ${safeErrorMessage(error, secrets)}` }], isError: true };
    }
  });
  return server;
};
