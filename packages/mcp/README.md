# Relay MCP

Local MCP v2 stdio server with exactly two tools:

| Tool | Use |
| --- | --- |
| `search_docs` | Find Relay SDK methods, signatures, parameters, and contract descriptions in the packaged documentation. |
| `execute` | Run TypeScript or JavaScript against the configured Agent's SDK client. |

There is no `talk` tool and no per-operation `relay_*` tool list.

## Selection

Use `search_docs` with query `selection` and verbose detail, then `execute`
with the SDK message-send method and ordered text/selection parts. Incoming
Message and event results retain `selected_values` and `reply_to`.

New human reply text is literal `• ` + each selected source label joined with
`\n`, followed by `selection_response` metadata in source-option order. Dispatch
with `selected_values` and the explicit source target, never label parsing.
Exact legacy comma-joined text remains a server compatibility input. The person
checks any number of options and submits them once; checking sends nothing, and
a person answers a given selection once. iOS may draw a checkmark in place of
each bullet and repeat the prompt's title, as presentation only.

## Payment

Use `search_docs` with query `payment`, then `execute`
`client.paymentRequests.create` and a message send whose only part is
`{ type: "payment", checkout_url }`.

## Start

Requires Node.js 22.22.3 or newer.

```sh
npx --yes @relaymessenger/mcp@staging
```

Agent authentication is unchanged: `RELAY_AGENT_TOKEN`, or the selected Relay
CLI profile. Select a profile with `--profile`. The API origin resolves from
`--api-url`, `RELAY_API_URL`, the selected profile, then the package environment:
`-staging` prereleases use the staging API; plain releases use production.
An explicit origin is preserved.
Do not put a token in a tool argument or submitted code. Configure it in the
server's environment or private Relay profile instead.

The server remains local stdio. It does not add HTTP, OAuth, a hosted executor,
or a new authentication flow.

## `search_docs`

```json
{"query":"send message idempotency","language":"typescript","detail":"default"}
```

- `query` is required.
- `language`: `typescript` (default), `javascript`, or `http`.
- `detail`: `default` or `verbose`.

Search is local and does not need a token. Its method index is generated from
`packages/sdk/src/client.ts`, SDK types, and the canonical
`contracts/relay-v1-openapi.yaml`. It returns the source contract hash. It does
not proxy the hosted documentation MCP or invent methods from a search result.

## `execute`

```json
{
  "code":"async function run(client) { return await client.contactCard.retrieve(); }",
  "intent":"Read this agent's contact card"
}
```

Define a top-level `run(client)` function. `intent` is optional and does not
change execution. TypeScript syntax is transpiled; the packaged SDK signatures
are available through `search_docs`.

The result includes `result` and `logs`. `console.log`, `info`, `warn`, `error`,
and `debug` are captured. SDK and execution failures return `isError: true`.
Each call starts fresh; variables do not persist between calls.

The supplied client exposes the SDK's initialized-client HTTP methods. SDK
pagination supports `hasNextPage()`, `getNextPage()`, and async iteration over
an awaited page. WebSocket callbacks and raw attachment upload
streams are not exposed by this JSON call bridge.

Execution uses a separate QuickJS WebAssembly runtime, not Node's `vm` or host
`eval`. Submitted code cannot access the host filesystem, process, environment,
imports, shell, or arbitrary `fetch`. Only calls to the generated SDK method
list cross the boundary. The actual SDK client and its Agent Token stay on the
host. API arguments and results cross as JSON; known local tokens are redacted
from returned values, logs, and errors.

Calls are limited to 30 seconds, 64 MiB of guest memory, and 1 MiB of accumulated
SDK/output text. Outstanding SDK requests receive cancellation when a call
ends. These limits do not undo a request that the API has already accepted.
Always await SDK calls and reuse a stable idempotency key for the same logical
message send. `execute` is not read-only: submitted SDK calls can change the
configured account.

## Development

From the monorepo root, in Daytona for Linux:

```sh
npm ci
npm run build --workspace @relaymessenger/sdk
npm run docs:generate --workspace @relaymessenger/mcp
npm run validate:mcp
```

`docs:check` proves the packaged method index still matches canonical source.
The protocol, Inspector, and installed-tarball tests require the exact two-tool
list and exercise both tools. Unit tests cover real SDK dispatch through
fixtures, pagination, auth errors, token redaction, guest isolation, and limits.

## Reference semantics

The two-tool workflow and `async function run(client)` shape follow Linq's
primary MCP source at `linq-team/linq-node` commit
`9f7ada2cf20fde604855dd69eef7d4df5c2f5b48`:
`packages/mcp-server/src/docs-search-tool.ts`, `code-tool.ts`, and
`local-docs-search.ts`. Linq's implementation uses Deno; Relay uses QuickJS and
states its narrower JSON/HTTP boundary above.

Photon's `photon-hq/mcp` source at
`61e3f2a9814b5a2cbe75f843d1cd9a67ae29ac90` documents a different, 67-tool surface.
Its per-operation list and additional iMessage powers are not copied here.
