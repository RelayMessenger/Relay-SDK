---
name: npm-package-authoring
description: "Author, audit, package, smoke-test, and publish npm packages and npm workspaces safely. Use when a request includes trigger phrases such as 'publish this npm package', 'prepare an npm release', 'audit package.json', 'fix exports or bin', 'fix npm pack contents', 'test the tarball', 'npm trusted publishing', 'npm OIDC', 'ENEEDAUTH', 'EOTP', 'npm 12 allowScripts', 'Windows npm shim EINVAL', 'EXDEV during packaging', or 'workspace package is missing built artifacts'."
---

# npm Package Authoring

Produce a consumer-valid tarball before touching the registry. Treat `package.json`, the packed tarball, the isolated installed package, the authentication mechanism, and registry state as separate contracts.

## Operating contract

- Inspect repository instructions, dirty state, lockfiles, supported Node/npm versions, workspace topology, and the existing release workflow first.
- Preserve unrelated changes. Never make a release from an unexplained dirty tree.
- Build once, pack once, retain the exact `.tgz`, and publish that retained tarball.
- Test the installed tarball outside the repository; source-tree tests cannot prove package correctness.
- Run cross-platform package tests on every supported OS. Do not weaken Windows assertions to imitate POSIX.
- Query registry state before every publish attempt and after every ambiguous outcome. Never blind-retry `npm publish`.
- Prefer npm OIDC trusted publishing over long-lived write tokens.
- Report local, CI, tarball, authentication, registry, and published-consumer evidence separately.

All shell blocks are Bash unless marked PowerShell. Use Node scripts for portable parsing instead of platform-specific `sed`, `grep`, or path assumptions.

## 1. Establish ground truth

Run from the repository root:

```bash
set -euo pipefail
git status --short
node --version
npm --version
npm config get registry
npm pkg get name version private packageManager engines repository publishConfig files exports bin workspaces
npm query .workspace 2>/dev/null || true
```

Then answer:

1. Which manifest is publishable: root or named workspace?
2. Which exact package name, version, registry, access level, and dist-tag are intended?
3. Which Node and npm versions does CI actually use?
4. Which scripts generate `dist/`, declarations, native assets, plugin bundles, or shims?
5. Which imports, subpaths, CLIs, and plugin discovery paths are public contracts?
6. Does release CI publish a directory or a retained tarball?
7. Does that exact package version already exist?

Stop if package identity or destination is ambiguous. Do not infer a package from the current directory in a monorepo.

## 2. Audit `package.json` as a contract

Use npm's current [`package.json` reference](https://docs.npmjs.com/files/package.json/) and Node's [package entry-point rules](https://nodejs.org/api/packages.html#package-entry-points).

### Identity and publication

- Require nonempty `name` and exact `version`; npm treats their pair as the immutable package-version identity.
- Require `private: false` or omit `private` only for a deliberately publishable manifest. npm refuses `private: true`.
- Set `publishConfig.registry`, `publishConfig.access`, and, when deliberate, `publishConfig.tag`. A prerelease on npm 11+ requires an explicit non-`latest` tag.
- Declare supported `engines.node`. Test the minimum and current supported Node majors.
- Include a license and actual license file.
- Keep runtime requirements in `dependencies`; build/test-only tools belong in `devDependencies`; host-provided APIs belong in `peerDependencies` when appropriate.

### Entry points and exports

Define every supported public entry point. Adding `exports` encapsulates all undeclared subpaths and can break existing consumers; `exports` takes precedence over `main` in supported Node versions ([Node docs](https://nodejs.org/api/packages.html#package-entry-points)).

Use an explicit shape such as:

```json
{
  "type": "module",
  "main": "./dist/index.cjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./feature": {
      "types": "./dist/feature.d.ts",
      "import": "./dist/feature.js",
      "require": "./dist/feature.cjs"
    },
    "./package.json": "./package.json"
  }
}
```

Apply these checks:

- Point every target to a relative `./` path that exists in the tarball, not merely in the source tree.
- Test `import` and `require` separately when both are advertised; dual-package state hazards are real.
- Export `./package.json` only if consumers need it.
- Preserve previously public subpaths or make the removal an explicit breaking change.
- Include a `default` branch for environment conditions when unknown runtimes need a universal fallback ([conditional exports](https://nodejs.org/api/packages.html#conditional-exports)).
- Do not treat nonstandard `module` as a replacement for Node's `exports` contract.

### Executables

For each `bin` entry:

- Point to a shipped file.
- Start a JavaScript CLI with `#!/usr/bin/env node`; npm requires the shebang for correct invocation ([npm `bin` docs](https://docs.npmjs.com/files/package.json/#bin)).
- Avoid file extensions in the public command name.
- Exercise the installed npm-created shim, not `node path/to/source-cli.js`.
- Assert POSIX executability only on POSIX; exercise the generated `.cmd` shim on Windows.

### Published files

Use an allowlist:

```json
{
  "files": [
    "dist/",
    "bin/",
    "templates/",
    "README.md",
    "LICENSE"
  ]
}
```

The `files` field controls the package payload, while some files are always included or excluded; inspect npm's exact [publish inclusion rules](https://docs.npmjs.com/cli/publish/#files-included-in-package). Do not rely on `.gitignore` as a release manifest. Never ship `.env`, `.npmrc`, signing material, fixtures with secrets, local databases, test recordings, or repository-only caches.

### Workspaces and repository metadata

- Keep the monorepo root `private: true` unless the root itself is the package.
- Give each publishable workspace its own identity, files, exports, bin, dependencies, and `publishConfig`.
- Use `--workspace=<name>` explicitly; commands that operate on the dependency tree link workspaces, while other commands operate on the root unless selected ([npm workspace publishing](https://docs.npmjs.com/cli/publish/#workspace)).
- Use the full repository object. For a monorepo package, include `directory`:

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/OWNER/REPOSITORY.git",
    "directory": "packages/PACKAGE"
  }
}
```

For GitHub trusted publishing, `repository.url` is a requirement, not decoration: it must exactly match the GitHub repository ([npm trusted-publisher troubleshooting](https://docs.npmjs.com/trusted-publishers/#troubleshooting)). Do not use a fork's workflow with the upstream URL still in the manifest.

## 3. Make the build deterministic

Start from the lockfile and the repository's tested package-manager version. Build all producer workspaces before any consumer or bundle workspace:

```bash
npm ci
npm run generate --if-present
npm run build --workspaces --if-present
npm test --workspaces --if-present
```

Require generated declarations, export targets, CLI files, templates, and runtime dependencies to exist before packing. Fail on generated drift:

```bash
git diff --exit-code -- package-lock.json '**/*.d.ts' 'dist/**'
```

Adjust the tracked path list to the repository. Do not gate ignored build output with `git diff`.

### Handle npm 12 install-script blocking

npm 12 makes dependency lifecycle scripts opt-in: unapproved `preinstall`, `install`, `postinstall`, implicit `node-gyp rebuild`, and `prepare` for non-registry dependencies do not run. Git and remote dependency resolution also default to denied. Review the [npm 12 announcement](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/) and the [`approve-scripts` contract](https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/).

Prepare policy under npm 11.16+ warnings before switching install CI to npm 12:

```bash
npm approve-scripts --allow-scripts-pending
npm approve-scripts PACKAGE_A PACKAGE_B
npm deny-scripts UNTRUSTED_PACKAGE
git diff -- package.json package-lock.json
npm ci
```

- Review each script and resolved version before approval; do not use `--all` by reflex.
- Keep the default pinned `package@version` approvals.
- Commit the resulting `allowScripts` policy with the dependency change.
- Use `npm install-scripts prune --dry-run` before removing stale approvals.
- Do not pass `--allow-scripts` to project-scoped `npm ci`; current npm rejects that. Use `package.json` policy ([npm install configuration](https://docs.npmjs.com/cli/install/#allow-scripts)).
- Use `--dangerously-allow-all-scripts` only as a temporary diagnostic, never as release CI policy.

If trusted publishing requires a newer npm than the project has validated, do **not** install `npm@latest` before `npm ci`. Install, build, test, pack, and smoke with the project's tested npm; upgrade npm only in the publish job immediately before the registry operation. Do not rerun dependency installation afterward.

## 4. Prove tarball hygiene

`npm publish` uses the same packing rules as `npm pack`; npm explicitly directs authors to `npm pack --dry-run` to inspect the payload ([npm pack](https://docs.npmjs.com/cli/pack/), [npm publish](https://docs.npmjs.com/cli/publish/)).

### Inspect, create, and retain one tarball

Keep staging on the repository volume so later atomic moves cannot cross devices:

```bash
set -euo pipefail
RELEASE_TMP="$PWD/.release-tmp"
PACK_DIR="$RELEASE_TMP/pack"
mkdir -p "$PACK_DIR"
find "$PACK_DIR" -maxdepth 1 -type f -name '*.tgz' -delete

npm pack --dry-run --ignore-scripts
npm pack --ignore-scripts --pack-destination "$PACK_DIR"

TARBALL_COUNT="$(find "$PACK_DIR" -maxdepth 1 -type f -name '*.tgz' | wc -l | tr -d ' ')"
test "$TARBALL_COUNT" = 1
TARBALL="$(find "$PACK_DIR" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
test -n "$TARBALL"
tar -tzf "$TARBALL" | sort > "$RELEASE_TMP/tar-contents.txt"
```

Do not assume `npm pack --json` is the only stdout: lifecycle tools and wrappers can emit logs. Use an empty pack directory and discover the one output file from the filesystem. Use `--ignore-scripts` only after an explicit build; this prevents `prepack` from silently changing the artifact during inspection.

Inspect `tar-contents.txt` for:

- every `exports`, `types`, `main`, and `bin` target;
- runtime assets and bundled plugins;
- unwanted source, tests, coverage, caches, credentials, or oversized fixtures;
- case-colliding paths that fail on case-insensitive filesystems;
- symlinks or absolute paths that consumers cannot use.

### Smoke-test the installed tarball in isolation

Create the consumer outside the repository so no workspace link, hoisted dependency, source file, or unbuilt output can rescue the package:

```bash
set -euo pipefail
PKG="$(node -p "require('./package.json').name")"
BIN="YOUR_PUBLIC_BIN"
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
CONSUMER="$(mktemp -d)"

cd "$CONSUMER"
npm init -y >/dev/null
npm install "$TARBALL"
npm ls --all
node -e "import(process.argv[1]).then(() => console.log('import ok'))" "$PKG"
node -e "require(process.argv[1]); console.log('require ok')" "$PKG"
npm pkg set scripts.smoke-cli="$BIN --version"
npm run smoke-cli
```

Delete the `require` check when CommonJS is not advertised. Replace the CLI assertion with deterministic output or behavior. Add public subpath imports, type-check a minimal TypeScript consumer, and exercise runtime assets.

If the package intentionally needs an install script, the smoke consumer must explicitly approve the exact installed package under npm 12 before install. Document why; otherwise require successful operation with the script blocked.

### Build bundled plugins from installed workspaces

Never bundle a plugin by reaching into `packages/plugin/src`, a hoisted root dependency, or a workspace symlink. Build workspace tarballs, install them into an isolated staging project, and point the bundler at those installed packages:

```bash
set -euo pipefail
STAGE="$PWD/.release-tmp/workspace-install"
TARBALLS="$STAGE/tarballs"
CONSUMER="$STAGE/consumer"
mkdir -p "$TARBALLS" "$CONSUMER"

npm ci
npm run build --workspaces --if-present
npm pack --workspace=@scope/core --ignore-scripts --pack-destination "$TARBALLS"
npm pack --workspace=@scope/plugin --ignore-scripts --pack-destination "$TARBALLS"

cd "$CONSUMER"
npm init -y >/dev/null
npm install "$TARBALLS"/*.tgz
node /absolute/path/to/bundle-plugins.mjs \
  --core "$CONSUMER/node_modules/@scope/core" \
  --plugin "$CONSUMER/node_modules/@scope/plugin"
```

Then pack the final package and repeat the isolated consumer smoke. This proves that the final bundle is constructible from publishable workspace artifacts rather than repository accident.

## 5. Enforce cross-platform packaging behavior

Run pack and installed-tarball smoke jobs on `ubuntu-latest`, `macos-latest`, and `windows-latest` when those platforms are supported.

### Launch Windows `.cmd` shims through a shell

npm creates `.cmd` shims for `bin` entries on Windows. `.bat` and `.cmd` files are not directly executable by `execFile`/`execFileSync`; Node requires a shell, `exec`, or `cmd.exe` ([Node child-process docs](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)). Direct execution commonly fails with `EINVAL`.

Use fixed, trusted commands and arguments:

```js
import { spawnSync } from "node:child_process";

const shim = process.platform === "win32"
  ? "node_modules/.bin/my-cli.cmd"
  : "node_modules/.bin/my-cli";

const result = spawnSync(shim, ["--version"], {
  shell: process.platform === "win32",
  stdio: "inherit",
  windowsHide: true
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
```

Never pass unsanitized user input through `shell: true`; shell metacharacters become code.

### Keep atomic rename scratch paths on the target volume

Atomic rename is a same-filesystem operation. A temp path on another volume can fail with `EXDEV`; silently converting the operation to copy-plus-delete removes atomicity. Real OSS projects encounter this exact failure ([electron-store issue](https://github.com/sindresorhus/electron-store/issues/106)).

- Stage beside the destination, for example `$GITHUB_WORKSPACE/.release-tmp`, not an unrelated system temp volume.
- Create the final temporary file in the destination directory, flush/close it, then rename within that directory.
- If cross-volume copying is acceptable, name it as non-atomic, verify the copied digest, and only then remove the source.
- Test Windows drive-letter and junction layouts; do not assume `RUNNER_TEMP` and `GITHUB_WORKSPACE` share a volume.

### Do not assert POSIX modes on Windows

On Windows, Node can change only the write permission; owner/group/other distinctions and executable bits are not implemented ([Node file-mode caveat](https://nodejs.org/api/fs.html#file-modes)). Gate POSIX mode assertions:

```js
import { statSync } from "node:fs";
import assert from "node:assert/strict";

if (process.platform !== "win32") {
  assert.notEqual(statSync("dist/cli.js").mode & 0o111, 0);
}
```

On Windows, prove behavior by invoking the installed `.cmd` shim. On POSIX, prove both the shebang and executable mode.

## 6. Configure npm OIDC trusted publishing

Trusted publishing exchanges a CI OIDC identity for a short-lived npm credential. It requires npm 11.5.1+ and Node 22.14.0+ and currently supports GitHub-hosted runners, not self-hosted GitHub runners ([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)).

### Configure npmjs.com

In the package's Settings -> Trusted Publisher:

1. Select GitHub Actions.
2. Enter the exact GitHub owner and repository.
3. Enter only the exact workflow filename, including `.yml` or `.yaml`; the file must live directly under `.github/workflows/`.
4. Enter the GitHub environment name if used.
5. Select allowed action: `npm publish`, `npm stage publish`, or both.
6. Confirm `package.json.repository.url` exactly matches the repository.

After OIDC works, set Publishing access to require 2FA and disallow traditional tokens. Configure stage-only OIDC for the strongest human-approval posture.

### Configure GitHub Actions

Resolve current supported action majors when editing. The example below reflects the current Node 24 generation; consult the [checkout v7 announcement](https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout/) and [setup-node releases](https://github.com/actions/setup-node/releases) rather than copying stale workflow snippets.

```yaml
name: Publish Package

on:
  push:
    tags: ["my-package@v*"]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
          package-manager-cache: false
      - run: npm ci
      - run: npm run build --workspaces --if-present
      - run: npm test --workspaces --if-present
      - run: npm run pack-and-smoke
      - name: Upgrade npm only for trusted publish
        run: npm install --global npm@latest
      - run: npm --version
      - name: Publish retained tarball
        run: npm publish .release-tmp/pack/PACKAGE-VERSION.tgz --access public
```

- Do not set a write-capable `NODE_AUTH_TOKEN` on the publish step; it can mask a broken OIDC configuration through token fallback.
- Provide a read-only token only to `npm ci` when private dependencies require it. Trusted publishing authenticates only publish/stage, not install, `view`, `access`, or `whoami`.
- Grant `id-token: write` to both caller and called workflows when using `workflow_call`.
- Expect automatic provenance for public packages from public repositories under GitHub/GitLab trusted publishing.

## 7. Diagnose authentication failures

### `ENEEDAUTH` locally

Verify registry and session before changing package settings:

```bash
npm config get registry
npm whoami --registry=https://registry.npmjs.org/
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

The web flow opens or prints an npm URL and completes passkey/TOTP/email step-up in the browser ([npm web authentication](https://docs.npmjs.com/accessing-npm-using-2fa/#sign-in-from-the-command-line-using---auth-typeweb)). Do not request passwords, passkeys, OTPs, or tokens in chat.

### `ENEEDAUTH` under OIDC

Check, in order:

1. npm >=11.5.1 and Node >=22.14.0.
2. GitHub-hosted runner.
3. `permissions.id-token: write` at the effective job/workflow level.
4. Exact owner, repository, workflow filename, optional environment, and allowed npm action in npm settings.
5. Exact `repository.url` match.
6. Caller workflow identity for `workflow_call`/manual invocation.
7. Absence of a stale write token that hides OIDC fallback.

npm does not validate trusted-publisher settings when saved; mismatch appears only at publish time ([troubleshooting](https://docs.npmjs.com/trusted-publishers/#troubleshooting)). `npm whoami` cannot prove OIDC because exchange occurs only during publish/stage.

### `EOTP` or 2FA step-up

- For an interactive publish, complete the passkey/browser prompt or supply a fresh TOTP only through the CLI's protected prompt. A TOTP can be passed with `npm publish --otp=CODE`, but avoid shell history and logs.
- In token-based CI, `EOTP` means the token cannot satisfy the package/account 2FA policy. Do not disable 2FA. Move publishing to OIDC or staged publishing.
- Classic npm tokens were removed in November 2025; write-enabled granular tokens have short lifetimes. npm has announced that 2FA-bypass granular tokens will lose direct-publish ability around January 2027; migrate now ([current npm token deprecation](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)).

## 8. Reconcile registry state before publish or retry

The version may exist even when the client timed out or the job was canceled. Reconcile identity and tarball integrity:

```bash
set -euo pipefail
PKG="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
TARBALL=".release-tmp/pack/PACKAGE-VERSION.tgz"
LOCAL_INTEGRITY="sha512-$(node -e "const fs=require('node:fs');const c=require('node:crypto');process.stdout.write(c.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64'))" "$TARBALL")"

set +e
REMOTE_INTEGRITY="$(npm view "$PKG@$VERSION" dist.integrity --json 2>.release-tmp/npm-view.err)"
VIEW_STATUS=$?
set -e

if [ "$VIEW_STATUS" -eq 0 ]; then
  REMOTE_INTEGRITY="$(node -e "process.stdout.write(JSON.parse(process.argv[1]))" "$REMOTE_INTEGRITY")"
  test "$REMOTE_INTEGRITY" = "$LOCAL_INTEGRITY" || {
    echo "Registry version exists with different tarball integrity" >&2
    exit 1
  }
  echo "Exact tarball already published; skip mutation and verify consumers"
elif grep -q 'E404' .release-tmp/npm-view.err; then
  echo "Version absent; one publish attempt is permitted"
else
  cat .release-tmp/npm-view.err >&2
  echo "Registry state unknown; do not publish" >&2
  exit 1
fi
```

Strip JSON quoting with a JSON parser, never shell text surgery. On an existing exact integrity:

```bash
npm view "$PKG@$VERSION" name version dist.tarball dist.integrity gitHead --json
VERIFY_DIR="$(mktemp -d)"
cd "$VERIFY_DIR"
npm init -y >/dev/null
npm install "$PKG@$VERSION"
npm ls "$PKG"
```

If absent, publish the retained tarball once. If the outcome is ambiguous, return to the read-only reconciliation block; allow bounded polling for registry propagation, but never issue a second publish while state is unknown. A same version with different integrity is a hard conflict, not a retry case.

## 9. Failure matrix

| Symptom | Owning cause | Required action |
|---|---|---|
| `ERR_PACKAGE_PATH_NOT_EXPORTED` | Missing `exports` subpath | Add the intended public subpath or declare the break; retest installed tarball. |
| `MODULE_NOT_FOUND` only after install | Target omitted by `files` or build | Inspect tar listing; fix files/build ordering. |
| CLI works from source, not install | Bad `bin`, missing shebang/file, or shim invocation | Fix manifest/shebang; invoke installed shim on every OS. |
| Windows `EINVAL` from `execFileSync` | `.cmd` shim launched without shell | Use `spawn`/`spawnSync` with a Windows shell. |
| `EXDEV` during atomic move | Scratch and destination are different volumes | Stage beside destination; preserve same-volume rename. |
| Mode assertion fails on Windows | POSIX permission assumption | Skip POSIX bit assertion; test `.cmd` behavior. |
| npm 12 install misses native/generated output | Dependency install script unapproved | Review and commit pinned `allowScripts`; rerun clean install. |
| Bundled plugin missing runtime files | Bundle built from source workspace/symlink | Build and install workspace tarballs; bundle from installed paths. |
| OIDC `ENEEDAUTH` | Identity/config mismatch | Check versions, runner, permission, workflow, environment, repository URL. |
| CI `EOTP` | Token cannot satisfy 2FA | Use OIDC or staged publishing; do not weaken account security. |
| Publish says version exists after timeout | First attempt likely succeeded | Reconcile registry integrity; skip if exact, fail if conflicting. |

## 10. Completion checklist

- [ ] Exact package/workspace, version, registry, access, and tag identified.
- [ ] `exports`, `types`, `main`, `bin`, `files`, dependencies, and repository metadata audited.
- [ ] `repository.url` exactly matches the trusted GitHub repository.
- [ ] Clean locked install, generation, build, tests, and npm 12 policy checks pass.
- [ ] Workspace plugins are constructed from installed workspace tarballs.
- [ ] One retained tarball has an inspected manifest and recorded SHA-512 integrity.
- [ ] Isolated import/require/subpath/type/CLI/runtime smoke passes.
- [ ] Linux, macOS, and Windows packaging behavior passes where supported.
- [ ] OIDC identity and 2FA posture are correct; no long-lived write token masks it.
- [ ] Registry state was reconciled immediately before mutation.
- [ ] Published package was reinstalled from the registry and verified.
- [ ] Final report distinguishes local-only, CI-green, published, and registry-verified states.
