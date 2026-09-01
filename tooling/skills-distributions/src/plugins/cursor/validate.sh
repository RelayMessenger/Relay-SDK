#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:?usage: validate.sh <TARGET_DIR>}"
SCHEMA_BASE="https://raw.githubusercontent.com/cursor/plugins/refs/heads/main/schemas"

uvx check-jsonschema --schemafile "$SCHEMA_BASE/plugin.schema.json" \
  "$TARGET_DIR/.cursor-plugin/plugin.json"
uvx check-jsonschema --schemafile "$SCHEMA_BASE/marketplace.schema.json" \
  "$TARGET_DIR/.cursor-plugin/marketplace.json"
node "$TARGET_DIR/scripts/validate-distribution.mjs" manifest

echo "validated Cursor distribution"
