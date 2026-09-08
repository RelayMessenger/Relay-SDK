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
