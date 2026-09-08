# Native CLI verification

Agent-made infrastructure choices, pending owner review. No product rules are defined here.

## Scope and safety

`agent-cli-platforms.mjs` runs SDK and CLI check/build/unit tests, packs both
workspace packages without lifecycle scripts, installs both tarballs outside
the repository, and exercises installed executables, help/version, temporary
profiles, stdin token storage, environment token resolution, logout, offline
doctor, and missing-token failures. Tokens are synthetic, never real credentials.
The temporary CLI config is deleted afterward. No publish or deployment runs.

The receipt identifies the actual `process.platform`, architecture, OS release,
Node executable version, git SHA/dirty state, command arguments, exit codes,
stdout/stderr, and tarball hashes. A unit-test failure keeps the run red while
allowing independent package evidence to be collected. `packageProof: passed`
does not mean every source test passed. Agent commands and a live runtime are
**not** covered until their approved feature commits and test cases arrive.

## Execution

Use the repository `.nvmrc` and `packageManager` versions, then install with
`npm ci`. Run **directly with Node**, not `npm exec -- node`: the latter fetched
a different Node package during the first Windows run.

```sh
node scripts/agent-cli-platforms.mjs
```

On the authorized Mac, set `RELAY_PLATFORM_RECEIPTS` to an absolute directory
under `_artifacts/agent-cli-build-20260908/verification` before running. Windows
runs on the real `windows-2025` GitHub job. That workflow also runs `macos-15`,
preserves LF checkout bytes, and uploads receipts even after a failure. It
has read-only repository permissions, a 45-minute timeout, and only triggers
on the dedicated verification branch (or explicit dispatch when available).

Linux installation, build, and testing must happen **only inside an owned
Daytona sandbox**. Supply its actual ID as `RELAY_DAYTONA_SANDBOX_ID`. This
required environment value is an execution guard, not independent proof of
Daytona hosting; retain the live sandbox creation/resource receipt too.
Obtain the Daytona key from Infisical at execution time; never put it in a
command argument, receipt, repository, or chat.

In Daytona, additionally run:

```sh
npm run validate:sdk
npm run validate:cli
```

Set `RELAY_PLATFORM_RECEIPTS` outside the checkout for those combined runs:
`scripts/consumer-smoke.mjs` uses the root `.release-tmp` directory, so the
harness default receipt directory is unsuitable for that sequence.

## Integration gates

- Main supplies feature commit SHAs; integrate only into the owned worktree,
  then push the verification branch to repeat native jobs against that SHA.
- Add feature-specific agent/runtime cases only after reading the delivered
  command contract; never treat global help for an unknown command as coverage.
- Main must approve/implement the narrowly scoped native-runner exception in
  `scripts/validate-workflows.mjs`. Its existing Blacksmith-only assertion
  rejects this workflow; verification does not edit or bypass that validator.
- Main owns staging landing. This branch never updates staging or npm tags.

## Mac-side Daytona transfer/exec helper

`scripts/agent-cli-platforms-daytona.mjs` uses the already installed SDK under
`WORKSPACE/_runtime/daytona-tools`; it performs no local Linux builds or installs.
It fetches `DAYTONA_API_KEY` directly from Infisical `prod:/admin` and only
allows optional Relay test secrets from explicit `dev`/`staging` folders.
Use named fixtures; leave unrelated operator data alone.

```sh
node scripts/agent-cli-platforms-daytona.mjs \
  --workspace /Users/advaitpaliwal/Code/Relay \
  --sandbox 21b65902-6e9d-4d91-8857-63cbccebe8f9 \
  --upload-local /absolute/path/to/source.tar.gz \
  --upload-remote /home/daytona/server-source.tar.gz \
  --exec-file /absolute/path/to/server-proof.sh \
  --cwd /home/daytona/agent-cli-server-proof \
  --receipt /absolute/path/to/server-proof-receipt.json
```

Command files must contain **no credential values**. To inject selected test
credentials into the remote process environment, add `--secret-env staging
--secret-path /server --secret-name DATABASE_URL` (repeat `--secret-name` for
other explicitly required names). Receipt output is redacted against fetched,
selected credential values. No credentials are included in process arguments.
Downloads via `--download-remote` / `--download-local` are for text receipts
only, never private configuration, token files, or binary archives.

Initialize the remote shell with `source /usr/local/share/nvm/nvm.sh` and
`nvm use 22.22.3` before installing/testing. Archive or transfer the intended
source SHA/patch explicitly; the helper does not guess which shared work to
copy. Server and CLI use separate directories in the owned sandbox.

## Prepared staging HTTP smoke (run only after main confirms deployment)

`node scripts/agent-cli-platforms-staging.mjs` is plan-only and sends **zero**
requests. Its six protocol-fixture unit tests do not prove a live deployment.
The executable fixes the origin to `https://api.staging.relayapp.im`; no origin
override or production polling exists. It creates at most two identities with
`verification-agent-cli-<run-id>-a/b` token labels, reads their own cards as the
local fixture inventory (there is no GET-list route), checks missing/invalid auth
and cross-fixture card/deletion isolation, then deletes only identities minted
by that run and checks revocation. No messages, operator profiles, existing
agents, or event acknowledgements are involved.

After main provides the deployed Server SHA, execute **inside Daytona**:

```sh
# DEPLOYED_SERVER_SHA must be the real confirmed deployment SHA, not a placeholder.
: "${DEPLOYED_SERVER_SHA:?main must confirm the deployed SHA}"
RELAY_DAYTONA_SANDBOX_ID=21b65902-6e9d-4d91-8857-63cbccebe8f9 \
node scripts/agent-cli-platforms-staging.mjs --execute \
  --run-id verify-20260908-first \
  --server-sha "$DEPLOYED_SERVER_SHA" \
  --canonical-spec /home/daytona/verification-canonical-openapi.yaml \
  --receipt /home/daytona/verification-receipts/staging-http-first.json \
  --private-state /home/daytona/.config/relay-verification/staging-http-first.json
```

Never download the private-state file into artifacts. It contains only this
run's one-time credentials, is created exclusively with mode 0600, and is removed
only when fixture deletion/revocation is confirmed. Uncertain creation, deletion,
or 409 preserves recovery state for main's review. The script never retries
creation/deletion or acknowledges pending events. A failed run is not permission
to rerun blindly (the contract's bootstrap limit still applies).

This HTTP proof does **not** claim final CLI `agents list` environment-isolation,
installed package behavior, or runtime handoff. Those tests follow the delivered
feature commands and native matrix against exact feature SHAs.

The staging smoke requires `--canonical-spec` for live execution. Transfer
main's exact canonical file from
`_worktrees/agent-management-server-20260908/contracts/developer/openapi.yaml`
to the above remote path; do not substitute an older SDK copy. Plan-only mode
can also accept this flag to validate the declared operations/auth/body and
record a SHA-256 without making requests. The live receipt preserves this
canonical hash alongside harness git SHA/dirty state and main's declared
deployment SHA. No canonical file is authored or edited by verification.

## New-credential native runtime proof (Linux/Daytona)

After SDK/CLI builds, run `node scripts/agent-cli-platforms-runtime.mjs` in the
owned Daytona CLI checkout with `RELAY_DAYTONA_SANDBOX_ID` and an absolute
`RELAY_RUNTIME_PROOF_RECEIPT` outside the checkout. This derives its transport
fixture from the existing OpenClaw gateway harness, but starts with an explicit
empty named runtime account instead of a preconfigured tokenFile.

It installs local SDK/CLI tarballs plus the local OpenClaw plugin tarball, runs
the **actual installed CLI executable** with `agents create --connect openclaw`,
checks that the new credential—not an unrelated environment credential—was
saved to the selected stopped runtime, verifies all other settings/accounts
are preserved, then starts the actual installed OpenClaw gateway. The fixture
requires that newly issued credential for Contact Card and WebSocket auth and
checks durable acknowledgement, replay suppression, heartbeat, a model turn,
and an idempotent outbound message. Bootstrap must happen exactly once.

This is native-process proof against loopback Relay/model fixtures, NOT live
staging API proof. Share links use `go.staging.relayapp.im`; no production Relay
request is made. All children and private fixtures are owned by this run and
removed afterward. No unrelated runtime process is stopped. Local candidate
tarball versions do not authorize publishing or overwriting registry versions.
