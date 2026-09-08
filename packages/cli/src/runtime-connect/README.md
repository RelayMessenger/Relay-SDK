# Optional runtime handoff integration

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
  // Retain result.rollback in memory if the user wants to undo this handoff.
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
  of ACL/xattr preservation. No persistent secret-bearing backup is created.
- Windows returns `windows-acl-verification-required` without writing. Native
  ACL preservation and Windows execution proof remain coordinated follow-up;
  simulated Windows path/gating tests are NOT native Windows proof.
- OpenClaw: strict JSON only; JSON5/comments/includes require the native config
  workflow. Select an EXISTING named account (or a default with an explicit
  inline credential). No brain or account is created. A chosen brain needs an
  existing exact Relay account binding. Secret references/tokenFile require the
  runtime secret workflow; duplicate inline credentials across slots are refused.
  Allowlist/default permission policy is retained, not expanded or replaced.
- Hermes: select the actual profile home. The profile `.env` must already
  contain resolved `RELAY_AGENT_TOKEN`, `RELAY_BASE_URL`, and absolute
  `RELAY_STATE_DIR`. YAML fallback and managed secret resolution are deliberately
  returned as `profile-resolution-required`, not inferred. This slice supports
  preserving/reusing a resolved identity, not replacing an occupied identity or
  bootstrapping a Hermes profile. Both durable SQLite and sidecar bindings must
  match; state is never rewritten. Corrupt/legacy/partial bindings fail closed.
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
- `workspace/hermes-relay-plugin/adapter.py:137-153,177-215,320-346,395-439`:
  profile-scope resolution, permission handling, state path and auth failures.
- `workspace/hermes-relay-plugin/state.py:18-20,29-128,167-235`:
  sidecar schema, fingerprints and database binding checks.
- `workspace/_sources/hermes-agent/hermes_cli/profiles.py:1-19` and
  `workspace/_sources/hermes-agent/agent/secret_scope.py:149-202,244-290`:
  profile homes and secret isolation. The initially requested
  `hermes-relay-plugin/_sources/hermes-agent` path was absent; this workspace
  official source clone was read instead.
- Installed OpenClaw source:
  `workspace/_worktrees/agent-cli-verification-20260908/node_modules/openclaw/docs/cli/index.md:44-52`:
  named profile isolation and explicit custom config/state path handling.

## Installation and native self-provisioning: separate additive work

No installer runs here, including during detection/planning. Runtime/plugin
absence means explicit user action, not a hidden install. Sources read for a
future consented installer action are `packages/openclaw/README.md:14-18`,
`packages/claude-code/README.md:27-51`,
`workspace/hermes-relay-plugin/README.md:53-59`, and the upstream Hermes installer
`workspace/_sources/hermes-agent/hermes_cli/plugins_cmd.py:715,952`. Installer
execution/version proof is not part of this configuration-only commit.

Agent-made assessment, pending owner review: native provisioning can be a
separate runtime onboarding action using the same approved create operation;
it need not invoke this CLI or add a Relay runner. The original saved owner
messages were read at
`workspace/_artifacts/dev-connect-independent-20260907/01-original-owner-messages.md`
(M000, M017, M037), alongside the current `agent-cli-build-20260908/CONTRACT.md`.
This assessment does not implement or infer new product rules from that earlier
exploration. Missing credential plus explicit creation consent must remain
separate from supplied-invalid, revoked, corrupt, or unreadable credentials.
Do not hook auto-create into adapter reconnect/auth-failure paths. Preserve
sender grants, report uncertain creation without a blind retry, and save the
one-time token privately before reporting success. Adapter/plugin changes and
runtime-native onboarding tests need their own ownership/commit after this
bounded handoff lands.

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
