# Contributing

Relay SDK changes must stay inside the current Relay v1 OpenAPI contract.

```bash
npm ci
npm run validate
```

Do not add polling, realtime transport, responding state, typing no-ops,
service discriminators, or APIs absent from the contract.

## Updating the Relay contract

`contracts/relay-v1-openapi.yaml` is vendored from Relay-Server. When it
changes (precedent: commit 010980a):

1. Copy the new file byte-for-byte to every vendored path that
   `scripts/validate-contract-copies.mjs` lists, and move `api.commit` and
   `api.openapi_sha256` in `skills/relay/references/relay-v1-lock.json` and its
   copy `plugins/relay/skills/relay/references/relay-v1-lock.json`. Run
   `npm run metadata:sync`. Commit.
2. Run `node scripts/contract-pin.mjs`. It tags that commit as
   `contract/<first 8 of api.openapi_sha256>`, pushes the tag, and prints the
   commit to pin.
3. Set `api.public_source.commit` in both lock files to the printed commit and
   commit again. The tag is what keeps that commit readable after the squash
   merge drops the PR-branch commits; `npm run validate` refuses a pin that is
   not reachable from `origin/main`, `origin/staging`, or that tag.

## Validate against an injected API

Validate the packed SDK against Relay's pre-release API without publishing:

```bash
RELAY_BASE_URL=https://api.staging.relayapp.im \
RELAY_AGENT_TOKEN=replace-me \
npm run staging:validate
```

## Production release

Nothing is published by hand. Two npm channels, kept apart:

- Staging publishes `X.Y.Z-staging.N` prereleases under the `staging`
  dist-tag on every push to the `staging` branch
  ([`publish-package-staging.yml`](.github/workflows/publish-package-staging.yml)).
  Nobody writes a version: [`scripts/staging-bump.mjs`](scripts/staging-bump.mjs)
  packs each package, compares its files with the tarball npm holds for the
  version in the tree, and when they differ moves the version, `-staging.N`
  to `-staging.N+1` while the plain `X.Y.Z` is unpublished, or to
  `X.Y.(Z+1)-staging.0` once `X.Y.Z` is on npm (a prerelease ranks below its
  base, so the base must move for main to publish again). Dependents are
  pinned to the versions decided in the same run. The workflow commits that
  bump as `github-actions[bot]` and publishes each changed package from that
  commit, in the order below; the commit reaches `staging` only after every
  package another package pins is on npm, so `staging` never names a
  dependency version npm lacks.
- Production publishes plain `X.Y.Z` versions under the `latest` dist-tag.
  The one deliberate act is merging `staging` into `main`; the push to `main`
  runs [`release.yml`](.github/workflows/release.yml), which:
  1. derives each package's version by stripping the `-staging.N` prerelease
     from the manifest in the tree (`0.3.0-staging.9` becomes `0.3.0`);
  2. pins every `@relaymessenger/*` dependency between these packages to those
     derived versions at publish time (the tree itself keeps staging's
     manifests, so no version-bump PR exists);
  3. skips any package whose derived version is already on npm;
  4. publishes the rest in dependency order with `--tag latest
     --no-provenance` on Blacksmith with the `npm-release` credential;
  5. creates the git tag `<prefix><version>` after each successful publish, as
     the record, never as the trigger;
  6. installs each published version clean from the registry and exercises it;
  7. rewrites every cookbook's Relay staging pins to the versions it published
     (lockfile, tarball URL and integrity with them), proves each folder on the
     release channel the way `cookbook-standalone` does on `main`, and lands
     that one commit on `staging` so the next promotion carries release pins.
     The dry run proves the same folders from the tarballs it packed.

Order and record tags, from [`scripts/release-packages.mjs`](scripts/release-packages.mjs):

| Order | Package | Record tag |
| --- | --- | --- |
| 1 | `@relaymessenger/sdk` | `sdk-v<version>` |
| 2 | `@relaymessenger/livekit` | `livekit-v<version>` |
| 3 | `@relaymessenger/chat-sdk-adapter` | `chat-sdk-v<version>` |
| 4 | `@relaymessenger/pi` | `pi-v<version>` |
| 5 | `relaymessenger` | `relaymessenger-v<version>` |
| 6 | `@relaymessenger/openclaw-plugin` | `openclaw-v<version>` |
| 7 | `relay-claude-channel` | `claude-channel-v<version>` |
| 8 | `@relaymessenger/elevenlabs` | `elevenlabs-v<version>` |

Dry run first: `workflow_dispatch` on `release.yml` derives every version,
prints the skip-or-publish decision, packs, and runs `npm publish --dry-run`,
then stops; `assume_published` lets a dry run rehearse a skip. Read the
registry back with `npm view <name> dist-tags`. The logic lives in
[`scripts/release-derive.mjs`](scripts/release-derive.mjs) (derivation, order,
plan, manifest rewrite; tested by `scripts/release-derive.test.mjs`) and
[`scripts/release-run.mjs`](scripts/release-run.mjs) (npm, registry, tag).

## CLI prerelease channel

Install `relaymessenger@staging` to work against the staging environment:

```sh
npx relaymessenger@staging --version
npm install --global relaymessenger@staging
```

That build talks to `https://api.staging.relayapp.im` on its own and installs
the Relay skill from the repository's `staging` branch; a plain `relaymessenger`
build talks to `https://api.relayapp.im` and installs from `main`. Either way an
explicit `--api-url` or `RELAY_API_URL` still wins, for example:

```sh
relay profiles add staging --api-url https://api.staging.relayapp.im
relay profiles use staging
printf '%s' "$STAGING_RELAY_AGENT_TOKEN" |
  relay auth login --profile staging --with-token
relay profiles list
```
