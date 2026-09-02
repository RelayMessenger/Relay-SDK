#!/usr/bin/env python3
"""Validate the canonical Relay skill and its distribution sources."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


DIST_ROOT = Path(__file__).resolve().parents[1]
ROOT = DIST_ROOT.parents[1]
SKILL_ROOT = ROOT / "skills" / "relay"
SKILL_PATH = SKILL_ROOT / "SKILL.md"
LOCK_PATH = SKILL_ROOT / "references" / "relay-v1-lock.json"


def fail(message: str) -> None:
    raise SystemExit(message)


def json_object(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"{path.relative_to(ROOT)} is not valid JSON: {error}")
    if not isinstance(value, dict):
        fail(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def text_files() -> list[Path]:
    allowed = {".md", ".json", ".yaml", ".yml", ".py", ".sh", ".mjs"}
    return sorted(
        path
        for source_root in (SKILL_ROOT, DIST_ROOT)
        for path in source_root.rglob("*")
        if path.is_file()
        and ".git" not in path.parts
        and path.suffix.lower() in allowed
    )


skill = SKILL_PATH.read_text(encoding="utf-8")
references = sorted((SKILL_ROOT / "references").iterdir())
all_text = "\n".join(path.read_text(encoding="utf-8") for path in text_files())

if not skill.startswith("---\n"):
    fail("Relay SKILL.md must start with YAML frontmatter")
if "\nname: relay\n" not in skill:
    fail("Relay SKILL.md must declare name: relay")

for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", skill):
    if "://" in target or target.startswith("#"):
        continue
    if not (SKILL_ROOT / target).is_file():
        fail(f"broken skill reference: {target}")

linked = set(re.findall(r"\((references/[^)]+)\)", skill))
expected = {
    str(path.relative_to(SKILL_ROOT))
    for path in references
    if path.is_file()
}
if linked != expected:
    fail(f"skill reference index drifted: {sorted(linked ^ expected)}")

required_markers = [
    "2026-08-30",
    "webhook-subscriptions",
    "/v1/websocket",
    "transport acknowledgements",
    "does not create Delivered or Read",
    "POST /v1/contact_requests",
    "contactRequests.create",
    "@relaymessenger/sdk@0.3.0-staging.6",
    "relay.chats.messages.send",
    "relay.chats.markAsRead",
    "relayApiOrigin(process.env.RELAY_API_URL)",
    "unknown",
]
for marker in required_markers:
    if marker.lower() not in all_text.lower():
        fail(f"locked Relay guidance is missing: {marker}")

# Construct retired terms so the validator does not reintroduce them into the
# repository it scans.
retired_terms = [
    "po" + "lling",
    "conversa" + "tions",
    "long" + " poll",
    "/v1/" + "ev" + "ents",
    "@relaymessenger/" + "cli",
    "2026-" + "02-03",
    "relay" + " listen",
]
for term in retired_terms:
    if term.lower() in all_text.lower():
        fail(f"retired Relay vocabulary returned: {term}")
if re.search(r"stream\s*=\s*true", all_text, flags=re.IGNORECASE):
    fail("retired Relay stream query vocabulary returned")

portable = json_object(DIST_ROOT / "plugin.json")
if portable.get("$schema") != (
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
):
    fail("portable plugin schema is not pinned to Agent Plugins 1.0.0")
if portable.get("name") != "relay":
    fail("portable plugin name must be relay")

mcp = json_object(DIST_ROOT / "mcp.json")
relay_mcp = mcp.get("mcpServers", {}).get("relayDocs", {})
if relay_mcp != {
    "type": "streamable-http",
    "url": "https://docs.relayapp.im/mcp",
}:
    fail("portable docs MCP configuration drifted")

claude = json_object(DIST_ROOT / ".claude-plugin" / "plugin.json")
if claude.get("name") != "relay":
    fail("Claude plugin name must be relay")
if claude.get("mcpServers", {}).get("relayDocs", {}).get("url") != (
    "https://docs.relayapp.im/mcp"
):
    fail("Claude docs MCP configuration drifted")

lock = json_object(LOCK_PATH)
if lock.get("api", {}).get("commit") != (
    "ddcbccb44b9f85e8c2e3e63fead9b81d52f2bd15"
):
    fail("Relay Server lock commit drifted")
if lock.get("docs", {}).get("commit") != (
    "7067d0a734febad683f724ec9386e68e33a25f3d"
):
    fail("Relay Docs lock commit drifted")
if lock.get("sdk", {}).get("version") != "0.3.0-staging.6":
    fail("Relay SDK lock version drifted")

for host in ("codex", "cursor"):
    build = DIST_ROOT / "src" / "plugins" / host / "build.sh"
    if not build.is_file():
        fail(f"missing {host} distribution builder")

source_digest = hashlib.sha256(SKILL_PATH.read_bytes()).hexdigest()
print(
    "validated Relay source: "
    f"{len(references)} references, skill sha256 {source_digest}"
)
