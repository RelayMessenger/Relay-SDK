#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:?usage: validate.sh <TARGET_DIR>}"
PLUGIN_ROOT="$TARGET_DIR/plugins/relay"
VALIDATOR_SHA="cdc1d592df7f066c141025cc8ae80bb3202580b6"
VALIDATOR_URL="https://raw.githubusercontent.com/openai/codex/${VALIDATOR_SHA}/codex-rs/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL "$VALIDATOR_URL" -o "$WORK/validate_plugin.py"
uv run --with pyyaml==6.0.3 "$WORK/validate_plugin.py" "$PLUGIN_ROOT"
node "$TARGET_DIR/scripts/validate-distribution.mjs" manifest

echo "validated Codex distribution"
