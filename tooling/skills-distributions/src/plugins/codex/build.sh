#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:?usage: build.sh <TARGET_DIR>}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SRC_DIR/../../.." && pwd)"

python3 "$ROOT/scripts/build-distribution.py" codex "$TARGET_DIR"
