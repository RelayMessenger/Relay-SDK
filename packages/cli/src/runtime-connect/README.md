# Optional runtime connect integration

This is a bounded offline configuration helper, not a runtime manager. The
public interface is `../runtime-connect.ts`. The caller owns SDK authentication,
selection/prompting, installation detection, and native runtime launch. No SDK,
CLI program, package manifest, or adapter changes belong to this module.

```ts
const plan = await planRuntimeConnect({ agent: resolvedAgent, target });
// Safe to render plan. Never render the input or a native runtime environment.
if (plan.status === 'ready') {
  const result = await applyRuntimeConnect(plan, {
    consent: true,
    runtimeStopped: true,
  });
  // Retain result.rollback in memory if the user wants to undo this change.
}
```

The plan must remain the same in-process object; serialized/copied plans are
not executable. `configured` means configuration saved, NOT a successful
runtime connection. Existing credentials are never replaced: a differing token
or origin returns `identity-change`. Invalid tokens never cause creation.

## Caller obligations and bounded support

- Supply absolute native paths resolved from the chosen runtime, not a guessed
  home path from its display profile name. Resolve trusted directory symlinks
  before selection; this helper rejects symlink traversal and linked files.
- Stop only the selected runtime before apply/rollback; do not falsely assert
  `runtimeStopped`. The directory lock serializes this helper's writers, not
  arbitrary editors. Snapshot comparison detects intervening edits, but an
  unrelated writer must remain stopped during the final compare/rename window.
- Existing secret files must be owner-private and their parent directories
  owner-controlled. Writes preserve POSIX mode bits, use a synced same-directory
  temporary file and atomic rename, and retain exact original bytes in memory
  for guarded rollback. This is not a power-loss-recovery journal, nor a claim
  of xattr preservation. Windows ACLs are inspected and cloned before writing secret bytes. No persistent secret-bearing backup is created.
- Windows uses native PowerShell ACL inspection. Foreign-principal credential
  reads or directory writes are refused. New files receive a protected ACL before
  any secret bytes; replacements clone the prior descriptor and compare ACLs as
  part of the guarded snapshot. Native Windows execution proof is separate from
  cross-platform unit coverage; no POSIX mode-bit assertion substitutes for it.
- OpenClaw: strict JSON only; JSON5/comments/includes require the native config
  workflow. An explicitly named empty/new account can be initialized; a known
  empty default can be initialized only without an occupied environment source.
  No brain is created. A chosen brain needs an
  existing exact Relay account binding. Secret references/tokenFile require the
  runtime secret workflow; duplicate inline credentials across slots are refused.
  Allowlist/default permission policy is retained, not expanded or replaced.
- Hermes: select the actual profile home and explicit absolute state directory.
  A token-empty profile can be initialized after parsing its YAML fallback and
  finding no occupied credential or durable account state. YAML bytes and sender
  permissions are preserved. Existing identity reuse verifies both SQLite and
  sidecar bindings; corrupt/legacy/partial bindings fail closed. Unknown secret
  references and YAML-only occupied credentials require native profile resolution.
- Claude: select a pre-existing session-scoped channel directory with explicit
  `RELAY_ALLOWED_SENDERS`. Global default channel directory is refused. Launch
  only the selected channel with its `RELAY_CHANNEL_DIR` and context, using the
  adapter's environment-fallback mode. A configured plugin `user_config` token
  takes precedence over the file; the caller must resolve that secure-config
  case through Claude rather than claim this file overrides it. Do not mutate
  `process.env`, global Claude settings, or other sessions. No first-adder grant.
- Environment syntax that cannot be roundtripped safely (duplicates, unsupported
  lines, inline comments, unsafe changed values) returns an action without edits.

## Source evidence read for this implementation

Paths below are relative to Relay-SDK unless prefixed with `workspace/`.

- `packages/openclaw/src/accounts.ts:37-72,117-140`: account inheritance,
  tokenFile/env precedence and selected account resolution.
- `packages/openclaw/src/gateway.ts:27-31,80-96` and
  `packages/openclaw/src/state.ts:574-589`: credential-keyed transport and SQLite
  path; a channel account name is not the durable credential identity.
- `packages/openclaw/src/channel.ts:304-311`: existing allowlist/open policy.
- `packages/claude-code/src/config.ts:62-100,110-175`: dotenv reader, required
  senders, selected channel directory, environment precedence, credential/state
  hash and session key.
- `packages/claude-code/.mcp.json:8-12` and `README.md:40-79`: plugin user config
  and manual environment fallback. No secure-store token replacement is claimed.
- The Hermes Relay plugin's own adapter and state modules: profile-scope
  resolution, permission handling, state paths, auth failures, the sidecar
  schema, its fingerprints and its database binding checks. Those files live in
  the Hermes plugin repository, not here.
- OpenClaw's own CLI documentation, `docs/cli/index.md`, on named profile
  isolation and explicit config and state paths. Read it from the installed
  `openclaw` package.

## Installation and native self-provisioning: separate additive work

No installer runs here, including during detection/planning. Runtime/plugin
absence means explicit user action, not a hidden install. Sources read for a
future consented installer action are `packages/openclaw/README.md:14-18`,
`packages/claude-code/README.md:27-51`,
and the Hermes plugin's own README and installer command. Proof that an installer
runs, and at which version, is not part of this configuration-only module.

## Verification

Run from the worktree root on authorized macOS or an owned Daytona Linux sandbox:

```sh
vitest run packages/cli/test/runtime-connect.test.ts
tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext \
  packages/cli/src/runtime-connect.ts
```

This checkout used the already-installed verification worktree binaries and
`--typeRoots` pointing to its `node_modules/@types`; no package installation or
manifest edit was needed. Actual installation, end-to-end runtime connection,
Linux execution and Windows execution are not claimed by these unit tests.
