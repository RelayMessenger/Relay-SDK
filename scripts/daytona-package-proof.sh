#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="${NVM_DIR:-/usr/local/share/nvm}"
# shellcheck source=/dev/null
source "$NVM_DIR/nvm.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_SHA="$(git -C "$ROOT" rev-parse HEAD)"
VERSION="$(node -p "require('$ROOT/packages/sdk/package.json').version")"
PROOF_ROOT="${RELAY_SDK_PROOF_ROOT:-/home/daytona/sdk-proof-$SOURCE_SHA}"
ARTIFACT="$PROOF_ROOT/artifact"
RECEIPTS="$PROOF_ROOT/receipts"
mkdir -p "$ARTIFACT" "$RECEIPTS"

run_source_and_tarball_proof() {
  local node_version="$1"
  local receipt_suffix="$2"
  nvm install "$node_version"
  nvm use "$node_version"
  node --version | tee "$PROOF_ROOT/node-$receipt_suffix.txt"
  npm --version | tee "$PROOF_ROOT/npm-$receipt_suffix.txt"
  npm ci
  npm run validate | tee "$PROOF_ROOT/source-$receipt_suffix.log"

  if [[ "$receipt_suffix" == "22" ]]; then
    npm run build
    npm pack \
      --workspace @relaymessenger/sdk \
      --ignore-scripts \
      --pack-destination "$ARTIFACT" \
      | tee "$PROOF_ROOT/npm-pack.txt"
  fi

  local tarball
  tarball="$(find "$ARTIFACT" -maxdepth 1 -name '*.tgz' -print -quit)"
  test -n "$tarball"
  node scripts/package-proof.mjs \
    --package "$tarball" \
    --expected-version "$VERSION" \
    --receipt "$RECEIPTS/tarball-node-$receipt_suffix.json" \
    | tee "$PROOF_ROOT/tarball-node-$receipt_suffix.log"
}

cd "$ROOT"
run_source_and_tarball_proof 22.22.3 22
run_source_and_tarball_proof 24 24

TARBALL="$(find "$ARTIFACT" -maxdepth 1 -name '*.tgz' -print -quit)"
sha256sum "$TARBALL" | tee "$PROOF_ROOT/tarball.sha256"
sha512sum "$TARBALL" | tee "$PROOF_ROOT/tarball.sha512"
git status --short | tee "$PROOF_ROOT/git-status.txt"

tar -C "$(dirname "$PROOF_ROOT")" \
  -czf "$PROOF_ROOT.tar.gz" \
  "$(basename "$PROOF_ROOT")"
sha256sum "$PROOF_ROOT.tar.gz"
