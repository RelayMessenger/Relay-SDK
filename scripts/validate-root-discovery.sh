#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_CHECKER="check-jsonschema==0.38.0"
CODEX_VALIDATOR_SHA="cdc1d592df7f066c141025cc8ae80bb3202580b6"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
node scripts/sync-root-discovery.mjs --check

uvx --from "$SCHEMA_CHECKER" check-jsonschema \
  --schemafile https://agent-plugins.org/schemas/1.0.0/plugin.schema.json \
  plugins/relay/plugin.json
uvx --from "$SCHEMA_CHECKER" check-jsonschema \
  --schemafile https://agent-plugins.org/schemas/1.0.0/mcp.schema.json \
  plugins/relay/mcp.json
uvx --from "$SCHEMA_CHECKER" check-jsonschema \
  --schemafile \
  https://raw.githubusercontent.com/cursor/plugins/refs/heads/main/schemas/marketplace.schema.json \
  .cursor-plugin/marketplace.json
uvx --from "$SCHEMA_CHECKER" check-jsonschema \
  --schemafile https://json.schemastore.org/claude-code-marketplace.json \
  .claude-plugin/marketplace.json

curl -fsSL \
  "https://raw.githubusercontent.com/openai/codex/${CODEX_VALIDATOR_SHA}/codex-rs/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py" \
  -o "$WORK/validate_plugin.py"
uv run --with pyyaml==6.0.3 \
  "$WORK/validate_plugin.py" plugins/relay

echo "validated Relay-SDK root Codex, Cursor, Claude, and portable manifests"
