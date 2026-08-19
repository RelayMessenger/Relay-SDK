---
name: oss-release-engineering
description: "Design, audit, repair, or operate verifiable open-source release pipelines across GitHub Actions, package registries, deployments, and app stores. Use when a request includes trigger phrases such as 'cut a release', 'release workflow', 'tag-driven release', 'check-tag', 'promote this SHA', 'deploy the same commit', 'publish idempotently', 'retry the release', 'verify release artifacts', 'update GitHub Actions', 'Node action runtime deprecation', 'clean up release branches', 'git cherry before deleting', 'parallel agents with worktrees', 'generated-file drift', 'wrangler types drift', or 'ship to TestFlight from CI'."
---

# OSS Release Engineering

Make every release a promotion of one verified source identity and one retained artifact set. Encode identity in tags and manifests, reconcile each external target before mutation, and prove terminal state from target artifacts rather than workflow appearance.

## Operating contract

- Inspect repository instructions, release scripts, workflow triggers, environments, package manifests, generated files, and current external state before editing.
- Preserve unrelated dirty work. Never hide it with stash, checkout, reset, rebase, or mass formatting.
- Define immutable identities before running CI: source SHA, tag, package name/version, artifact digest, deploy revision, and store build tuple.
- Build a releasable artifact once. Promote that exact artifact through CI, deploy, registry, and TestFlight/App Store; never rebuild downstream.
- Treat registry, deployment provider, GitHub Release, and store as independent state machines.
- Reconcile before every retry. Classify state as absent, exact, conflicting, or unknown; mutate only when absent.
- Verify terminal target state. A green workflow or uploader exit is intermediate evidence.
- Record exact commands, workflow/run IDs, source SHA, artifact digests, target IDs, and URLs.

All shell blocks are Bash unless labeled otherwise. Replace placeholders explicitly; do not let agents infer package paths, store apps, accounts, or environments from proximity.

## 1. Inventory release identities and targets

Run read-only discovery:

```bash
set -euo pipefail
git status --short
git remote -v
git branch -vv
git worktree list --porcelain
git tag --sort=-creatordate | head -30
find .github/workflows -maxdepth 1 -type f -print | sort
node --version 2>/dev/null || true
npm --version 2>/dev/null || true
```

Produce an identity ledger before changing workflows:

| Identity | Required value | Evidence source |
|---|---|---|
| Source SHA | Full 40-character commit | `git rev-parse HEAD`, workflow run `head_sha` |
| Release tag | Package plus version | `GITHUB_REF_NAME`, remote tag object |
| Package | Exact registry name and manifest path | release map plus `package.json` |
| Version | Exact semver | tag and manifest equality |
| Artifact | Filename, size, SHA-256/SHA-512 | retained build manifest |
| Deploy | Provider revision/version | provider API and live version endpoint |
| Apple build | Bundle ID, marketing version, build string | archive plus App Store Connect |

Stop on an unresolved identity. “Main,” “latest,” “current artifact,” newest run, newest TestFlight build, and mutable dist-tags are selectors, not release identities.

## 2. Define a tag grammar that encodes package and version

Use one documented grammar:

- Single-package repository: `PACKAGE@v1.2.3`; allow `v1.2.3` only when package identity is unambiguous and permanent.
- Monorepo: `PACKAGE_ID@v1.2.3`, for example `relay-sdk@v1.2.3`.
- Map `PACKAGE_ID` to manifest path and expected registry name in tracked data; do not derive paths from arbitrary tag text.

Example `release-packages.json`:

```json
{
  "relay-sdk": {
    "path": "packages/sdk",
    "name": "@relay/sdk"
  },
  "relay-cli": {
    "path": "packages/cli",
    "name": "@relay/cli"
  }
}
```

Trigger only matching tags:

```yaml
on:
  push:
    tags:
      - "*@v*"
```

Protect release tags and restrict the GitHub environment used for publishing; npm also recommends tag protection and deployment environments for trusted publishing ([npm security practices](https://docs.npmjs.com/trusted-publishers/#additional-security-measures), [GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).

## 3. Make `check-tag` the first refusing preflight

Run preflight before installing dependencies, signing, deploying, or requesting OIDC credentials. Refuse malformed tags, unknown packages, manifest mismatches, wrong tag targets, dirty generated state, or pre-existing conflicts.

```yaml
jobs:
  check-tag:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      source_sha: ${{ steps.check.outputs.source_sha }}
      package_id: ${{ steps.check.outputs.package_id }}
      package_path: ${{ steps.check.outputs.package_path }}
      package_name: ${{ steps.check.outputs.package_name }}
      version: ${{ steps.check.outputs.version }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - id: check
        env:
          RELEASE_TAG: ${{ github.ref_name }}
          EXPECTED_SHA: ${{ github.sha }}
        run: |
          set -euo pipefail
          node <<'NODE'
          const fs = require('node:fs');
          const { execFileSync } = require('node:child_process');
          const tag = process.env.RELEASE_TAG;
          const match = /^(?<id>[a-z0-9][a-z0-9-]*)@v(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
          if (!match) throw new Error(`Invalid release tag: ${tag}`);

          const releaseMap = JSON.parse(fs.readFileSync('release-packages.json', 'utf8'));
          const selected = releaseMap[match.groups.id];
          if (!selected) throw new Error(`Unknown package id: ${match.groups.id}`);
          const manifest = JSON.parse(fs.readFileSync(`${selected.path}/package.json`, 'utf8'));
          if (manifest.name !== selected.name) throw new Error(`Package-name mismatch: ${manifest.name}`);
          if (manifest.version !== match.groups.version) {
            throw new Error(`Tag ${match.groups.version} != manifest ${manifest.version}`);
          }
          if (manifest.private === true) throw new Error('Refusing to release private package');
          const tagSha = execFileSync('git', ['rev-list', '-n', '1', tag], { encoding: 'utf8' }).trim();
          if (tagSha !== process.env.EXPECTED_SHA) {
            throw new Error(`Tag SHA ${tagSha} != workflow SHA ${process.env.EXPECTED_SHA}`);
          }
          const out = process.env.GITHUB_OUTPUT;
          fs.appendFileSync(out, `source_sha=${tagSha}\n`);
          fs.appendFileSync(out, `package_id=${match.groups.id}\n`);
          fs.appendFileSync(out, `package_path=${selected.path}\n`);
          fs.appendFileSync(out, `package_name=${selected.name}\n`);
          fs.appendFileSync(out, `version=${match.groups.version}\n`);
          NODE
```

This regex parses a structured release identifier, not natural-language intent. Keep the grammar deliberately narrow.

Also preflight remote tag identity:

```bash
git fetch --force --tags origin
LOCAL_TAG_SHA="$(git rev-list -n 1 "$GITHUB_REF_NAME")"
test "$LOCAL_TAG_SHA" = "$GITHUB_SHA"
```
Never move an existing public release tag to another commit. Create a new patch version.

## 4. Build once and emit a signed identity manifest

Use an explicit dependency ladder:

```text
check-tag -> CI matrix -> release build -> artifact verification -> target promotions
```

Make every downstream job depend on the same successful `check-tag`, CI, and build jobs. Build from the tag SHA, not from the moving default branch.

Create a release manifest beside the artifacts:

```bash
set -euo pipefail
ARTIFACT="dist/PACKAGE.tgz"
SHA256="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
SIZE="$(wc -c < "$ARTIFACT" | tr -d ' ')"
node - "$ARTIFACT" "$SHA256" "$SIZE" <<'NODE'
const fs = require('node:fs');
const [artifact, sha256, size] = process.argv.slice(2);
const manifest = {
  schemaVersion: 1,
  repository: process.env.GITHUB_REPOSITORY,
  sourceSha: process.env.GITHUB_SHA,
  tag: process.env.GITHUB_REF_NAME,
  workflowRunId: process.env.GITHUB_RUN_ID,
  workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  artifact,
  sha256,
  size: Number(size)
};
fs.writeFileSync('dist/release-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
NODE
```

Upload the artifact and manifest together with `if-no-files-found: error`. GitHub artifact downloads validate the server-recorded digest ([artifact digest validation](https://docs.github.com/en/actions/tutorials/store-and-share-data#validating-artifacts)). Add an artifact attestation for binaries or release manifests that consumers will verify; grant `contents: read`, `id-token: write`, and `attestations: write`. Attestations bind repository, workflow, environment, commit SHA, and event ([GitHub attestation model](https://docs.github.com/en/actions/concepts/security/artifact-attestations)).

```yaml
- id: upload
  uses: actions/upload-artifact@v7
  with:
    name: release-${{ github.sha }}
    path: |
      dist/PACKAGE.tgz
      dist/release-manifest.json
    if-no-files-found: error
    retention-days: 30

- uses: actions/attest@v4
  with:
    subject-path: dist/PACKAGE.tgz
```

The OpenAI Codex release workflow is a concrete OSS example of SHA-pinned actions, cross-platform build artifacts, separate signing/packaging jobs, and final artifact verification ([workflow](https://github.com/openai/codex/blob/main/.github/workflows/rust-release.yml)). Use it as evidence for the pattern, not as a copy-paste template.

## 5. Promote the exact build run and SHA

### Same workflow

Use `needs: build` and `actions/download-artifact` without rebuilding. Assert the embedded manifest before any target mutation:

```yaml
promote:
  needs: [check-tag, ci, build]
  runs-on: ubuntu-latest
  steps:
    - uses: actions/download-artifact@v8
      with:
        name: release-${{ needs.check-tag.outputs.source_sha }}
        path: release
    - env:
        EXPECTED_SHA: ${{ needs.check-tag.outputs.source_sha }}
      run: |
        set -euo pipefail
        ACTUAL_SHA="$(node -p "require('./release/release-manifest.json').sourceSha")"
        test "$ACTUAL_SHA" = "$EXPECTED_SHA"
        shasum -a 256 -c <(node -e "const m=require('./release/release-manifest.json'); console.log(m.sha256+'  ./release/'+m.artifact.split('/').pop())")
```

### Separate promotion workflow

Require immutable `build_run_id` and full `expected_sha` inputs. Never select the newest successful run.

```bash
set -euo pipefail
REPO="${GITHUB_REPOSITORY:?}"
RUN_ID="${BUILD_RUN_ID:?}"
EXPECTED_SHA="${EXPECTED_SHA:?}"
RUN_JSON="$(gh api "repos/$REPO/actions/runs/$RUN_ID")"
RUN_SHA="$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(x.head_sha)" "$RUN_JSON")"
RUN_STATUS="$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.status))" "$RUN_JSON")"
RUN_CONCLUSION="$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.conclusion))" "$RUN_JSON")"
test "$RUN_SHA" = "$EXPECTED_SHA"
test "$RUN_STATUS" = "completed"
test "$RUN_CONCLUSION" = "success"
gh run download "$RUN_ID" --repo "$REPO" --name "release-$EXPECTED_SHA" --dir release
```

GitHub's artifact API exposes the artifact digest and producing workflow's `head_sha`; query it when assembling evidence ([Actions artifacts API](https://docs.github.com/en/rest/actions/artifacts)). A cross-workflow `download-artifact` call must specify a token and run ID ([GitHub artifact docs](https://docs.github.com/en/actions/tutorials/store-and-share-data#downloading-artifacts-during-a-workflow-run)).

### Deploy and store without rebuilding

- Deploy the downloaded archive/image digest. Pass the expected SHA to the provider and expose it through a version endpoint or provider metadata.
- Upload the downloaded `.ipa`/`.pkg` to App Store Connect. Do not invoke `xcodebuild archive` in the promotion job.
- Record Bundle ID, marketing version, build string, source SHA, artifact SHA-256, workflow run ID, and App Store Connect build ID in the evidence ledger.
- Treat uploader success as “uploaded, processing.” Apple states that a build appears only after processing and uniquely identifies it by Bundle ID, version, and build string ([upload lifecycle](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds), [build identity](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information)). Query App Store Connect until the intended build resource exists and reaches the required TestFlight/App Store state ([Builds API](https://developer.apple.com/documentation/appstoreconnectapi/builds)).

## 6. Make every target idempotent

For each target, implement this state machine:

```text
read target state
  absent      -> mutate once -> read and verify terminal state
  exact       -> skip mutation -> verify terminal state
  conflicting -> fail with both identities
  unknown     -> stop; do not mutate or retry
```

Do not classify errors by a broad “already exists” substring when a structured registry/API read exists.

### npm registry gate

Retain and publish one tarball. Compare its SHA-512 integrity with registry `dist.integrity` before deciding:

```bash
set -euo pipefail
PKG="${PACKAGE_NAME:?}"
VERSION="${PACKAGE_VERSION:?}"
TARBALL="${PACKAGE_TARBALL:?}"
LOCAL="sha512-$(node -e "const fs=require('node:fs'),c=require('node:crypto');process.stdout.write(c.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64'))" "$TARBALL")"

set +e
REMOTE_JSON="$(npm view "$PKG@$VERSION" dist.integrity --json 2>npm-view.err)"
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  REMOTE="$(node -e "process.stdout.write(JSON.parse(process.argv[1]))" "$REMOTE_JSON")"
  test "$REMOTE" = "$LOCAL" || { echo "Immutable version conflict" >&2; exit 1; }
  echo "publish=false" >> "$GITHUB_OUTPUT"
elif grep -q 'E404' npm-view.err; then
  echo "publish=true" >> "$GITHUB_OUTPUT"
else
  cat npm-view.err >&2
  exit 1
fi
```

Run `npm publish "$TARBALL"` only when `publish=true`. On a rerun, exact state becomes a verification-only path. The Changesets action explicitly warns custom publishers to account for already-published versions because a later default-branch commit can retrigger release logic ([real OSS guidance](https://github.com/changesets/action#custom-publishing)).

After publish or skip:

```bash
npm view "$PKG@$VERSION" name version dist.tarball dist.integrity gitHead --json
VERIFY_DIR="$(mktemp -d)"
cd "$VERIFY_DIR"
npm init -y >/dev/null
npm install "$PKG@$VERSION"
npm ls "$PKG"
```
### GitHub Release gate
Run this gate in a job with `permissions.contents: write` and `GITHUB_TOKEN` in the environment.

```bash
set -euo pipefail
TAG="${RELEASE_TAG:?}"
EXPECTED_SHA="${SOURCE_SHA:?}"
git fetch --tags origin
TAG_SHA="$(git rev-list -n 1 "$TAG")"
test "$TAG_SHA" = "$EXPECTED_SHA"
HTTP_STATUS="$(curl --silent --show-error --output release.json --write-out '%{http_code}' \
  --header "Accept: application/vnd.github+json" \
  --header "Authorization: Bearer $GITHUB_TOKEN" \
  --header "X-GitHub-Api-Version: 2026-03-10" \
  "https://api.github.com/repos/$GITHUB_REPOSITORY/releases/tags/$TAG")"
case "$HTTP_STATUS" in
  200) echo "Release exists; verify assets and skip creation" ;;
  404) gh release create "$TAG" --verify-tag --title "$TAG" dist/* ;;
  *) cat release.json >&2; exit 1 ;;
esac
```

Verify every expected asset name, size, and digest after creation or skip. A release object without the intended assets is incomplete, not success.

### Deployment gate

- Query the provider's immutable deployment ID/revision and source SHA first.
- Skip if the expected SHA/artifact digest is already deployed to the target environment.
- Fail if the named release version points to another SHA.
- Deploy once if absent, then query provider state **and** the live endpoint until both report the expected identity.
- Never use provider commands that implicitly deploy “latest build” or current working tree.

### TestFlight/App Store gate

- Query by exact Bundle ID + version + build string.
- Skip upload when that exact build exists; continue status verification.
- Fail if the release ledger maps the build tuple to a different source/artifact digest.
- Upload once when absent. Poll App Store Connect for processing, beta review, group assignment, or App Store version association as required.
- Never upload another binary under an already-used build tuple; increment the build string and create a new evidence record.

## 7. Verify result artifacts, not workflow badges

A badge is a mutable summary of a selected branch/event. It does not prove which SHA, artifact, registry version, deployment revision, or store build reached the target.

Collect this minimum release evidence:

```bash
git rev-parse "$RELEASE_TAG^{commit}"
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID" --jq '{id,head_sha,status,conclusion,event,html_url}'
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/artifacts" --jq '.artifacts[] | {id,name,size_in_bytes,digest,expired,archive_download_url}'
gh release view "$RELEASE_TAG" --json tagName,url,isDraft,isPrerelease,assets
gh attestation verify dist/PACKAGE --repo "$GITHUB_REPOSITORY"
npm view "$PACKAGE_NAME@$PACKAGE_VERSION" name version dist.integrity dist.tarball gitHead --json
```

Add provider-specific reads:

- deployment ID, terminal status, environment, source SHA, artifact/image digest, and live `/version` response;
- App Store Connect build ID, Bundle ID, version, build string, processing state, TestFlight groups/review state, or selected App Store version build;
- checksums/signature/notarization evidence for downloadable binaries.

Write `release-evidence.json` or an equivalent durable record. Include timestamps as evidence metadata, never as identity.

## 8. Keep GitHub Actions current

Before editing any `uses:` reference, read [references/github-actions-current.md](references/github-actions-current.md). Refresh its release queries, then apply its current-major, full-SHA pinning, Node runtime, self-hosted runner, breaking-change, and dependency-update checks. Never assume the job's `setup-node` version changes another action's embedded Node runtime.

## 9. Maintain trunk and branch topology

Prefer one releasable trunk plus short-lived topic branches. GitHub Flow is a lightweight branch workflow and deletes completed branches to prevent accidental reuse ([GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)); trunk-based development likewise rejects long-lived development branches ([model](https://trunkbaseddevelopment.com/)).

Release tags must resolve to reviewed trunk commits unless a documented emergency release branch policy says otherwise. Never keep parallel “almost main” branches as release sources.

### Prove patch equivalence before deleting a branch

Merge ancestry alone fails after squash, cherry-pick, or rebase. `git cherry` compares patch IDs and marks commits with an upstream-equivalent patch as `-` and unique commits as `+` ([Git docs](https://git-scm.com/docs/git-cherry)).

```bash
set -euo pipefail
git fetch origin --prune
BRANCH="origin/topic-branch"
TRUNK="origin/main"

git log --left-right --cherry-pick --oneline "$TRUNK...$BRANCH"
git cherry -v "$TRUNK" "$BRANCH" | tee /tmp/topic-cherry.txt

if grep -q '^+' /tmp/topic-cherry.txt; then
  echo "Branch has patches absent from trunk; do not delete" >&2
  exit 1
fi

git worktree list --porcelain
git branch -vv
```

Only after review of remote parity, open PRs, worktrees, and the `git cherry` output should an authorized cleanup delete local/remote branches. Never interpret an empty ordinary commit diff as patch equivalence without checking the range.

### Isolate parallel agents with worktrees

Git supports multiple linked working trees so branches can be checked out concurrently ([`git worktree`](https://git-scm.com/docs/git-worktree)). Give every agent one directory and one branch:

```bash
git fetch origin
git worktree add -b agent/release-a ../repo-release-a origin/main
git worktree add -b agent/release-b ../repo-release-b origin/main
git worktree list --porcelain
```

- Never run multiple agents in one worktree.
- Never use stash as a coordination primitive.
- Keep generated output and lockfile ownership explicit; these are shared logical resources even across directories.
- Inspect status before removal. Use `git worktree remove PATH` only after work is persisted or intentionally discarded.

## 10. Gate generated-file and lockfile drift

Treat generators and their outputs as one atomic source change. When configuration changes, regenerate and commit affected types, clients, schemas, manifests, snapshots, and lockfiles in the same commit.

Generic CI gate:

```bash
set -euo pipefail
npm ci
npm run generate
npm run build
git diff --exit-code -- package-lock.json generated/ src/generated/
```

Make the gate repository-specific. Fail with a message that names the regeneration command.

### Wrangler example

Wrangler configuration is the Worker source of truth, and `wrangler types` generates binding/runtime declarations such as `worker-configuration.d.ts` ([Cloudflare configuration docs](https://developers.cloudflare.com/workers/wrangler/configuration/), [TypeScript generation](https://developers.cloudflare.com/workers/languages/typescript/)). A new `vars`, secret declaration, KV/R2/D1 binding, service binding, Durable Object, compatibility date, or flag can change generated types.

Commit config and generated types together:

```bash
npx wrangler types
git diff --exit-code -- wrangler.jsonc wrangler.toml worker-configuration.d.ts
```

If multiple Workers exist, run the command in every affected workspace or pass explicit configs/output paths. Do not hand-edit generated declarations.

### Lockfile gate

When workspace/package-manager config or dependencies change:

```bash
npm install --package-lock-only --ignore-scripts
git diff --exit-code -- package.json package-lock.json 'packages/*/package.json'
npm ci
```

Commit intentional lockfile changes with the config/manifest change. A CI-only regeneration that leaves a diff proves the commit is incomplete.

## 11. Failure matrix

| Symptom | Classification | Required response |
|---|---|---|
| Tag version differs from manifest | Refusing preflight | Fix version commit or create the correct tag; never publish. |
| Tag points to unexpected SHA | Identity conflict | Stop; never move a public tag. |
| CI green on main, tag SHA untested | Wrong evidence | Run/gate CI for the tag SHA. |
| Deploy job checks out `main` | Exact-SHA violation | Download retained artifact; assert manifest SHA. |
| Retry reports package version exists | Possibly exact | Compare registry integrity; skip exact, fail conflicting. |
| Registry/API unavailable during check | Unknown state | Stop; do not publish or retry. |
| GitHub Release exists without assets | Incomplete target | Reconcile expected asset names/digests; repair idempotently. |
| Upload succeeded but TestFlight build absent | Async intermediate | Poll App Store Connect processing; uploader exit is not terminal. |
| Badge green, live version old | Target not promoted | Inspect provider deployment and live version identity. |
| Node runtime deprecation warning | Stale action/runner | Upgrade current action major and runner; do not change only job Node. |
| Branch not ancestor after squash merge | Ambiguous topology | Use `git cherry`; preserve any `+` patches. |
| `wrangler` config changed, types did not | Generated drift | Regenerate types and commit in same change. |

## 12. Release completion checklist

- [ ] Tag grammar, package map, and `check-tag` refusal are tested.
- [ ] Tag, manifest, and source SHA match exactly.
- [ ] Required CI is green for that SHA, not merely the default branch.
- [ ] One retained artifact set and release manifest record exact digests.
- [ ] Downstream jobs download and verify that artifact; none rebuild it.
- [ ] Every external target passed absent/exact/conflicting/unknown reconciliation.
- [ ] Rerun paths skip exact mutations and perform full verification.
- [ ] GitHub Release assets, registry package, deployment, live endpoint, and store state are directly verified where in scope.
- [ ] Action majors/runtimes and self-hosted runners are current.
- [ ] Generated files and lockfiles are clean after regeneration.
- [ ] Topic branches have no unique patches before authorized deletion.
- [ ] Final evidence record includes SHA, tag, version, run ID, artifact digests, target IDs, URLs, and unverified gaps.
