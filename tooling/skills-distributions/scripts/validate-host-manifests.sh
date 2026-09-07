#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

uvx --from check-jsonschema==0.38.0 check-jsonschema \
  --schemafile https://agent-plugins.org/schemas/1.0.0/plugin.schema.json \
  "$ROOT/plugin.json"
uvx --from check-jsonschema==0.38.0 check-jsonschema \
  --schemafile https://agent-plugins.org/schemas/1.0.0/mcp.schema.json \
  "$ROOT/mcp.json"
uvx --from check-jsonschema==0.38.0 check-jsonschema \
  --schemafile https://json.schemastore.org/claude-code-plugin-manifest.json \
  "$ROOT/.claude-plugin/plugin.json"
uvx --from check-jsonschema==0.38.0 check-jsonschema \
  --schemafile https://json.schemastore.org/claude-code-marketplace.json \
  "$ROOT/.claude-plugin/marketplace.json"

echo "validated portable and Claude host manifests"
