// The one catalog of everything this repository releases.
//
// Both release paths read this file, so a package is described exactly once:
//   - scripts/release-catalog.mjs resolves the staging publish
//     (.github/workflows/publish-package-staging.yml)
//   - scripts/release-derive.mjs and scripts/release-run.mjs drive the one
//     production release on main (.github/workflows/release.yml), in this
//     object's order: every Relay dependency before its dependents
//
// `scripts/validate-workflows.mjs` asserts this catalog against the tree on
// every CI run: each entry's package.json must carry the declared name and
// repository directory. `tagPrefix` names the git tag that records a publish
// (`<prefix><version>`); the tag is a record, never a trigger.
//
// `smoke` is what proves a *registry-installed* copy of the package works. It
// is deliberately per-package data rather than per-package code: the six
// release workflows previously shipped as six near-identical copies of one
// file plus six near-identical release scripts, and their smoke assertions
// drifted away from the packages they guard. Every value below was read from
// this tree on 2026-09-07, not carried over from those copies.
//
// Order matters: scripts/release-derive.mjs refuses a catalog where a package
// precedes a Relay package it depends on.
export const releasePackages = {
  sdk: {
    directory: "packages/sdk",
    workspace: "@relaymessenger/sdk",
    validate: "validate:sdk",
    tagPrefix: "sdk-v",
    smoke: {
      imports: [
        {
          specifier: "@relaymessenger/sdk",
          named: [
            "Attachments",
            "Chats",
            "Messages",
            "Relay",
            "RelayAPIError",
            "RELAY_V1_OPERATIONS",
            "Webhooks",
            "WebhookSubscriptions",
            "runWebSocket",
            "verifyWebhookSignature",
          ],
          default: true,
        },
      ],
    },
  },
  "chat-sdk-adapter": {
    directory: "packages/chat-sdk-adapter",
    workspace: "@relaymessenger/chat-sdk-adapter",
    validate: "validate:chat-sdk",
    tagPrefix: "chat-sdk-v",
    smoke: {
      imports: [
        {
          specifier: "@relaymessenger/chat-sdk-adapter",
          named: [
            "RELAY_WEBHOOK_EVENT_TYPES",
            "RelayAdapter",
            "RelayApiError",
            "RelayClient",
            "createRelayAdapter",
            "decodeRelayThreadId",
            "encodeRelayThreadId",
            "verifyWebhookSignature",
          ],
        },
      ],
    },
  },
  cli: {
    directory: "packages/cli",
    workspace: "relaymessenger",
    validate: "validate:cli",
    // Canonical bare CLI only; the former scoped package is not dual-published.
    tagPrefix: "relaymessenger-v",
    smoke: {
      files: ["dist/cli.js"],
      run: {
        entry: "dist/cli.js",
        args: ["--help"],
        expect: "Official CLI for Relay v1 Agent resources.",
      },
    },
  },
  mcp: {
    directory: "packages/mcp",
    workspace: "@relaymessenger/mcp",
    validate: "validate:mcp",
    tagPrefix: "mcp-v",
    smoke: {
      files: ["dist/cli.js"],
      parse: ["dist/cli.js"],
      imports: [
        { specifier: "@relaymessenger/mcp", named: ["createRelayMcpServer"] },
        {
          specifier: "@relaymessenger/mcp/auth",
          named: ["DEFAULT_API_URL", "resolveAgentAuth", "validateApiURL"],
        },
      ],
    },
  },
  openclaw: {
    directory: "packages/openclaw",
    workspace: "@relaymessenger/openclaw-plugin",
    validate: "validate:openclaw",
    tagPrefix: "openclaw-v",
    smoke: {
      files: [
        "openclaw.plugin.json",
        "index.ts",
        "setup-entry.ts",
        "dist/index.js",
        "dist/setup-entry.js",
      ],
      parse: ["dist/index.js", "dist/setup-entry.js"],
    },
  },
  "claude-code": {
    directory: "packages/claude-code",
    workspace: "relay-claude-channel",
    validate: "validate:claude-code",
    tagPrefix: "claude-channel-v",
    smoke: {
      files: [".claude-plugin/plugin.json", "runtime/server.mjs"],
      parse: ["runtime/server.mjs"],
      // Keep this plugin artifact manifest aligned with its own package version.
      manifestVersion: ".claude-plugin/plugin.json",
    },
  },
};

export const releaseKeys = Object.keys(releasePackages);

export function releaseEntry(key) {
  const entry = releasePackages[key];
  if (!entry) {
    throw new Error(
      `Unknown release package: ${key}. Known: ${releaseKeys.join(", ")}`,
    );
  }
  return { ...entry, key };
}
