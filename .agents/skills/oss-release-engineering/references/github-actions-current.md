# GitHub Actions currency

Read this reference whenever a release task creates, audits, or changes a GitHub Actions workflow. Refresh the live release queries before choosing versions; the dated table is evidence, not an evergreen guarantee.

## Version policy

- Audit every `uses:` reference, including reusable workflows and local composite actions.
- Pin the current supported major at minimum.
- Prefer a full commit SHA for release/security-sensitive workflows and append the reviewed version as a comment:

```yaml
- uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
```

- Review release notes before upgrading; artifact extraction paths, cache defaults, authentication inputs, and minimum runner versions can change across majors.
- Enable Dependabot or Renovate so full-SHA pins still receive reviewable updates.

## Primary-source snapshot: 2026-07-18

| Action | Current major | Primary evidence |
|---|---:|---|
| `actions/checkout` | `v7` | [GitHub v7 announcement](https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout/) |
| `actions/setup-node` | `v6` | [setup-node releases](https://github.com/actions/setup-node/releases) |
| `actions/cache` | `v5` | [cache repository](https://github.com/actions/cache) |
| `actions/upload-artifact` | `v7` | [upload-artifact releases](https://github.com/actions/upload-artifact/releases) |
| `actions/download-artifact` | `v8` | [download-artifact releases](https://github.com/actions/download-artifact/releases) |
| `actions/attest` | `v4` | [GitHub attestation workflow](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) |

Query the live releases instead of copying the table:

```bash
set -euo pipefail
for REPO in actions/checkout actions/setup-node actions/cache actions/upload-artifact actions/download-artifact actions/attest; do
  gh api "repos/$REPO/releases/latest" --jq '"\(.tag_name)\t\(.html_url)"'
done
```

Confirm the selected tag's embedded runtime and exact SHA:

```bash
ACTION_REPO="actions/download-artifact"
ACTION_TAG="v8.0.1"
gh api "repos/$ACTION_REPO/git/ref/tags/$ACTION_TAG" --jq '.object.sha'
gh api "repos/$ACTION_REPO/contents/action.yml?ref=$ACTION_TAG" \
  --jq '.content' | base64 --decode | rg 'using:|node24'
```

Annotated tags can point to a tag object; peel to its commit before using the returned SHA. Verify the commit in the release/tag UI and preserve the version comment.

## Node runtime migration

Node-backed actions carry their own embedded Node runtime. Node 20 reached EOL in April 2026; GitHub began switching Actions to Node 24 by default on June 16, 2026 and plans to remove Node 20 later in 2026 ([GitHub deprecation notice](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)).

- Upgrade old action majors; `actions/setup-node` configures later shell steps only.
- Update self-hosted runners before Node 24 actions; current first-party Node 24 releases require runner 2.327.1+.
- Test custom JavaScript actions with `runs.using: node24`.
- Check Node 24 OS/architecture support before keeping old macOS or ARM32 self-hosted runners.
- Remove `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION`; it is a temporary migration escape hatch.
- Treat `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` as a readiness test, not a permanent substitute for updated actions.

## Automated update gate

Use a tracked `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
```

For each update PR:

1. Inspect upstream release notes and `action.yml` runtime.
2. Confirm the minimum runner version and supported operating systems.
3. Run tag, artifact upload/download, cache, OIDC, and promotion paths affected by the action.
4. Update full SHA and version comment together.
5. Reject stale majors even when the workflow still appears green; runtime removals turn warnings into hard failures.
