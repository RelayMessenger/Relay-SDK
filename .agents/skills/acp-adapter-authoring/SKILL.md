---
name: acp-adapter-authoring
description: >-
  Author, review, debug, validate, package, or release Relay coding-agent integrations in the relaymessenger developer repository. Use when adding or changing the engine catalog, Claude/Codex bundled ACP adapters, an external ACP runtime such as Hermes, shell-free process spawning, ACP initialization/session load/prompt/permission handling, Relay permission cards and replies, Claude Code or OpenClaw channel plugins, support-tier/version claims, manifests, gateway harnesses, or installed-tarball ACP smokes.
---

# ACP Adapter Authoring

## Establish ground truth

1. Locate the developer repository root. Treat paths below as repository-relative.
2. Run `git status --short`, `git branch --show-current`, and `git rev-parse --short HEAD`. Preserve unrelated changes.
3. Read `packages/relaymessenger/README.md`, the target runtime's catalog/adapter code, its tests, its package manifest, and `package-lock.json` before editing.
4. Inspect the installed runtime directly with `<binary> --version` and its non-interactive readiness check. Inspect the latest upstream release separately. Record both; do not silently make them equal.
5. Decide whether the integration is an **engine** or a **channel** before writing code.

Use this ownership map:

| Concern | Owning source |
| --- | --- |
| Engine names and external runtime specs | `packages/relaymessenger/src/engine/catalog.ts` |
| ACP process, handshake, sessions, turns, permissions | `packages/relaymessenger/src/engine/acp.ts` |
| Engine process-tree shutdown | `packages/relaymessenger/src/engine/process.ts` |
| Engine boundary types | `packages/relaymessenger/src/engine/types.ts` |
| Engine selection and lifecycle | `packages/relaymessenger/src/flags.ts`, `packages/relaymessenger/src/cli.ts` |
| External runtime preflight | `packages/relaymessenger/src/doctor.ts` |
| Durable conversation/session binding | `packages/relaymessenger/src/store.ts` (`SessionStore`) |
| Relay receive/turn/reply loop | `packages/relaymessenger/src/receive.ts` |
| Permission card, parser, timeout, durable approval | `packages/relaymessenger/src/permissions.ts` |
| Claude Code channel | `integrations/claude-code/server.ts`, `integrations/claude-code/src/bridge.ts`, `integrations/claude-code/src/poller.ts` |
| OpenClaw channel | `integrations/openclaw/src/channel.ts`, `integrations/openclaw/openclaw.plugin.json` |
| Release and installed-artifact proofs | `.github/workflows/ci.yml`, `scripts/`, integration `scripts/` |

## Choose engine versus channel

Choose an **ACP engine** when `relaymessenger start` should own the receive loop and drive one coding runtime turn over ACP stdio. A Relay conversation maps to one runtime session; Relay receives `session/update` output and answers `session/request_permission`.

Choose a **native channel plugin** when the target runtime already owns agent lifecycle, sessions, memory, routing, tools, or a gateway and exposes a channel/plugin surface. Implement Relay as one transport inside that runtime instead of wrapping the runtime as a pretend ACP preset.

Apply the current examples exactly:

- Keep Claude Code, Codex, and Hermes in the ACP engine catalog.
- Keep OpenClaw as a native gateway channel in `integrations/openclaw`; do not add it to `ENGINE_NAMES` merely because it is an agent runtime.
- Keep the Claude Code channel in `integrations/claude-code` as an alternative to the bundled Claude ACP engine. It speaks Claude's experimental channel contract over MCP; it is not ACP. See [Claude Code channels](https://code.claude.com/docs/en/channels-reference).

Ask: “Who owns the session and turn loop?” If `relaymessenger` owns it, use an engine. If the runtime owns it and Relay is one ingress/egress transport, use a channel.

## Extend the engine catalog without runtime mutation

Keep `packages/relaymessenger/src/engine/catalog.ts` as the closed catalog owner. Update `ENGINE_NAMES`, `EngineName`, display labels, CLI help, flags tests, doctor output, README, and runtime tests together.

Choose one installation tier:

### Bundle an adapter

Use this for Relay-shipped Claude/Codex-style wrappers:

1. Add the adapter as an **exact** dependency in `packages/relaymessenger/package.json`; update `package-lock.json` with the package manager, never by hand.
2. Add its package name to `ADAPTER_PACKAGES` in `engine/acp.ts`. Do not add a version literal: `ADAPTER_VERSIONS` is derived from the manifest at load time and throws if the pin is not exact.
3. Resolve the installed executable module with `createRequire(import.meta.url).resolve(...)`.
4. Launch it with `process.execPath` and one resolved entrypoint argument.
5. Prove the dependency value, lockfile, resolved file, packed tarball, and installed tarball agree.

`packages/relaymessenger/package.json` is the single source of the adapter versions. Read it for the current pins rather than trusting a version quoted anywhere else, and change a pin only as an explicit, tested dependency update.

### Use an external runtime

Use this for user-installed Hermes-style CLIs:

1. Add one `EXTERNAL_ENGINE_SPECS` entry with a literal `command`, literal ACP `args`, `versionArgs`, official `docsUrl`, optional non-secret `checkArgs`, and a permission timeout only when the runtime imposes a shorter deadline.
2. Require the binary to exist on `PATH`.
3. Run its version and readiness commands through `crossSpawn.sync(command, args, ...)` in `doctor.ts`.
4. Launch the exact same installed binary and ACP argv from `engineProcessSpec`.
5. Never download, update, or install the external runtime during `relaymessenger start`.

Hermes uses:

```ts
command: "hermes"
args: ["acp"]
versionArgs: ["--version"]
checkArgs: ["acp", "--check"]
```

Require `hermes acp --check` before claiming readiness. Keep its 60-second server permission deadline below Relay's timeout by using the current 55-second broker setting. Follow the official [Hermes ACP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/).

## Spawn shell-free and minimize inherited authority

Construct a process as `{ command, args[] }`. Pass it to `crossSpawn(command, args, options)` with no `shell` option. Never construct `"command arg1 arg2"`, pass user input through a shell, or use `sh -c`, `bash -c`, `cmd /c`, `npm exec`, `npx`, `uvx`, or a registry `latest` package in the runtime path.

For bundled adapters, execute:

```text
<current Node executable> <require-resolved installed adapter entrypoint>
```

For external runtimes, execute the installed binary exactly, for example:

```text
hermes acp
```

Keep arguments immutable catalog data. Do not accept an arbitrary command string from a CLI flag or config file.

Use `engineEnv()` as an allowlist. Pass platform basics and named provider/runtime prefixes only. Keep Relay Agent Tokens, deploy credentials, GitHub tokens, npm tokens, cloud credentials, `NODE_OPTIONS`, and unrelated parent secrets out of the child environment. Add a variable only through a narrow exact name or prefix in `RELAYMESSENGER_ENGINE_ENV`; do not add an “inherit everything” escape hatch.

Spawn the adapter as a process-group leader on POSIX. On shutdown, terminate the entire adapter/agent tree through `terminateProcessTree`; do not leave a detached coding agent after a fatal `401`, `409`, signal, or bridge exit.

ACP stdio reserves stdout for newline-delimited UTF-8 JSON-RPC; send logs to stderr. See [ACP transports](https://agentclientprotocol.com/protocol/v1/transports).

## Implement the ACP lifecycle exactly

Use the official TypeScript SDK's fluent client and NDJSON stream. Do not invent JSON shapes: [ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript).

### Initialize

1. Spawn and connect the stdio transport.
2. Register client handlers for `session/request_permission` and `session/update` before initialization.
3. Send `initialize` with the SDK `PROTOCOL_VERSION`, `clientInfo`, and only the client capabilities actually implemented.
4. Require the returned `protocolVersion` to equal the requested version. Close and report an actionable error on mismatch.
5. Read capability presence as support; treat omission as unsupported. Cache `agentCapabilities.loadSession === true`.

ACP requires initialization before session creation and capability negotiation controls optional methods: [initialization](https://agentclientprotocol.com/protocol/v1/initialization).

### Create or load the right session

Key durable bindings by Relay `conversation_id`, and persist `{ engine, session_id, cwd, created_at }` in the paired account's `sessions.json` through `SessionStore`.

1. Reuse an in-process session only when both conversation and `cwd` match.
2. Load a persisted session only when its engine and `cwd` exactly match the requested engine and repository **and** the agent advertised `loadSession`.
3. Call `session/load` with the stored ID, the absolute `cwd`, and the intended MCP server list.
4. Accept replayed `session/update` notifications without treating replay as the new Relay turn. ACP requires `session/load` to replay history before it returns.
5. On load failure, log the failure, delete that one stale binding, call `session/new`, and persist the replacement.
6. If load is unsupported, call `session/new`; never probe `session/load` anyway.
7. Never load a session from a different engine or working directory. That can leak another repository's context and authorize work in the wrong tree.

Follow [ACP session setup and load semantics](https://agentclientprotocol.com/protocol/v1/session-setup).

### Run, stream, cancel, and reconnect

1. Register a live turn state before accepting turn-owned updates.
2. Send `session/prompt` with the session ID and supported content blocks.
3. Accumulate `agent_message_chunk` text in order. Merge sparse `tool_call` and `tool_call_update` records by `toolCallId`; never erase a known field with `undefined`.
4. Surface tool activity without treating it as final output.
5. Resolve every `session/request_permission` before the agent proceeds.
6. Finish only when the original `session/prompt` response returns a `stopReason`; return accumulated text plus that reason.
7. Send `session/cancel` for an explicit abort. Clear only live connection/session maps after process failure; preserve durable bindings for a capability-gated reload.
8. Clear a rejected initialization promise so a later turn can reconnect; never cache a permanently rejected connect promise.

Follow the [ACP prompt-turn lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn) and [tool-call/permission contract](https://agentclientprotocol.com/protocol/v1/tool-calls).

## Preserve the message-native permission protocol

Treat a permission request as a security protocol, not UI copy.

1. Merge the current permission request's tool call with earlier sparse updates.
2. Extract the full security-relevant operation: `rawInput`, affected locations, text content, and diffs.
3. Set `inputComplete` true only when the complete raw operation or a complete diff is available. Deny without posting when input is incomplete, unserializable, or exceeds the full-preview limit. Never approve a truncated command whose dangerous suffix may be hidden.
4. Create a durable, create-once approval file **before** posting the card.
5. Arm the in-process waiter **before** the HTTP POST so an immediate tap cannot race registration.
6. Post one Relay message containing:
   - a human-readable `text` part with `yes <id>` / `no <id>` fallback;
   - a `data` part with `kind: "agent_permission_request"`, `request_id`, tool details, and options;
   - option origins such as `{ kind: "agent_permission_request", request_id: id }`;
   - a deterministic `agent-perm-<id>` idempotency key.
7. Parse an origin-tagged data-part tap first. Tolerate current echo variants (`option_id`, `option`, `choice`, or `behavior`) only after validating the request-id alphabet.
8. Parse typed `y|yes|n|no <id>` as fallback. Require an open request, the pinned owner, and the exact conversation that received the card.
9. Map allow to the runtime's `allow_once` option when present and deny to `reject_once` when present. If no deny option exists, return ACP `cancelled`; never map deny to allow.
10. Consume verdict-shaped messages for stale, missing, or wrong-conversation requests so they never become coding-agent prompts, but do not resolve the wrong request.
11. On timeout, missing complete input, card-post failure, or absent live turn, deny/cancel and remove the local waiter safely.

Do not retry rejected credentials forever:

- In `packages/relaymessenger/src/receive.ts`, treat Relay `401` as terminal, tell the user to pair again, throw, and dispose the engine tree.
- In `integrations/claude-code/src/poller.ts`, abort the poller on `401`; do not enter exponential backoff for an authentication error.
- Reconcile an ambiguous write with its stable idempotency key before retrying. Rate-limit notification retries; never generate a fresh key for the same logical card or reply.

Keep the engine broker and Claude channel parser behavior aligned. When changing the card or verdict grammar, update both `packages/relaymessenger/src/permissions.ts` and `integrations/claude-code/src/bridge.ts`, plus both test suites.

## Author channels as channels

For OpenClaw, implement Relay through OpenClaw's channel contracts:

- Declare and validate the plugin manifest.
- Resolve accounts and owner/allowlist security before dispatch.
- Let the OpenClaw gateway own route/session resolution and agent execution.
- Use Relay long-poll as channel ingress and the durable outbound adapter for replies.
- Preserve one consumer per Agent Token, stable idempotency, cursor/dedupe state, and gateway lifecycle.
- Prove the **packed plugin installed into a real gateway**, not a source import.

For Claude Code's channel preview:

- Expose the `claude/channel` and `claude/channel/permission` MCP capabilities.
- Deliver owner-authenticated Relay events as channel notifications with durable delivery IDs.
- Require Claude to acknowledge only after handling.
- Provide a stable-send-id reply tool.
- Fail closed when the owner, account state, or complete permission input cannot be established.
- Stop on a rejected Agent Token instead of polling forever.

Do not claim channel availability from an engine test or engine availability from a plugin manifest.

## Keep support tiers honest

Use an evidence ledger per runtime version and platform. Record:

```text
runtime name
local version and executable path
upstream latest version and primary-source URL
adapter/package version and lockfile integrity
platform + Node/Python version
readiness/preflight result
ACP initialize + negotiated version + capabilities
session/new result
session/load or explicit unsupported result
prompt invocation + streamed/final reply result
permission request + phone/card decision + runtime outcome
Relay reply delivery + idempotent retry result
packed/installed artifact hash
```

Use these labels:

- **Catalogued**: manifest/catalog entry exists.
- **Starts**: installed artifact launches and negotiates ACP.
- **Validated**: invocation, session continuity, permission, and Relay reply paths pass for the recorded version/platform.
- **Supported**: validated paths pass from the shipped packed artifact on the maintained platform matrix, with docs and failure behavior verified.

Never call a runtime “supported” after only `--check`, `initialize`, unit tests, or source execution.

Record version skew instead of upgrading it away. Example authoring snapshot from 2026-07-18: local `/Users/advaitpaliwal/.local/bin/hermes` reported `0.16.0`, passed `hermes acp --check`, while upstream released `0.18.2`. Record that delta and test the installed `0.16.0`; do not run `hermes update` as part of adapter validation. Cite the [Hermes releases](https://github.com/NousResearch/hermes-agent/releases) when recording upstream state.

## Run the validation ladder

Run from the developer repository root in order. Stop at the first red layer; do not let a later smoke hide an earlier contract failure.

1. Install exactly from the lockfile when dependencies changed: `npm ci`.
2. Run typechecks, builds, and unit suites across the workspaces:

```sh
npm run validate
```

3. Run strict Claude plugin and marketplace manifest validation:

```sh
npm run validate:claude-plugin
```

4. Run the clean installed-runtime OpenClaw gateway path:

```sh
npm run gateway:harness
```

Require evidence for `GET /v1/agents/me`, `GET /v1/events`, a model completion, and `POST /v1/messages` from the isolated installed plugin.

5. Pack every publishable/bundled artifact and run installed-tarball checks:

```sh
npm run pack:check
```

6. Prove ACP startup from an installed `relaymessenger` tarball, not the source tree. Create a disposable directory, pack `relaymessenger`, install that exact tarball, then run:

```sh
npm run runtime:smoke -- claude <temp-install>/node_modules/relaymessenger
npm run runtime:smoke -- codex <temp-install>/node_modules/relaymessenger
hermes --version
hermes acp --check
npm run runtime:smoke -- hermes
```

The runtime smoke proves only subprocess resolution and ACP initialization. It does **not** clear the `Validated` or `Supported` tier.

7. Run or add an end-to-end adapter harness for every changed engine that proves:

```text
initialize -> session/new -> session/prompt -> session/update
-> session/request_permission -> selected/cancelled response
-> prompt stopReason -> Relay POST /v1/messages
-> restart -> capability-gated session/load -> next prompt
```

Exercise allow, deny, timeout, incomplete input, wrong conversation, stale request ID, `401`, `409`, adapter crash, and idempotent reply replay. Use a real installed adapter/runtime version for the final support claim; a fake ACP peer is unit coverage only.

8. Re-run the platform matrix from `.github/workflows/ci.yml` when process spawning, manifests, installation, or path resolution changes. Test Windows `.cmd` resolution without turning engine execution into a shell string.

## Finish with evidence, not a compatibility claim

Report:

- engine or channel shape and why;
- catalog, manifest, process, protocol, permission, and package files changed;
- exact local and upstream versions, including deltas;
- every validation command and platform;
- which of invocation, session load, permission allow/deny, reply, restart, and rejected-token paths were directly proven;
- packed artifact identity or hash;
- support tier reached;
- every unrun path and why;
- persistence state: local-only, committed, pushed, CI, published, or registry-verified.

Never convert “the process starts” into “the integration is supported.”
