#!/usr/bin/env python3
"""Build a host repository from the canonical Relay-SDK skill source."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path


DISTRIBUTION_ROOT = Path(__file__).resolve().parents[1]
ROOT = DISTRIBUTION_ROOT.parents[1]
SOURCE_REPOSITORY = "https://github.com/RelayMessenger/Relay-SDK"
LOCK_SOURCE = ROOT / "skills" / "relay" / "references" / "relay-v1-lock.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("host", choices=("codex", "cursor"))
    parser.add_argument("target")
    return parser.parse_args()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )


def clear_target(target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for child in target.iterdir():
        if child.name == ".git":
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()


def copy_tree(source: Path, target: Path) -> None:
    shutil.copytree(source, target, dirs_exist_ok=True, copy_function=shutil.copy2)


def source_identity() -> tuple[str, str]:
    dirty = subprocess.check_output(
        ["git", "-C", str(ROOT), "status", "--porcelain"],
        text=True,
    )
    if dirty:
        raise SystemExit("Relay-SDK must be clean before generation")
    branch = subprocess.check_output(
        ["git", "-C", str(ROOT), "symbolic-ref", "--short", "HEAD"],
        text=True,
    ).strip()
    if branch != "staging":
        raise SystemExit("Relay-SDK distributions must be generated from staging")
    commit = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    branch_commit = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "refs/heads/staging"],
        text=True,
    ).strip()
    if commit != branch_commit:
        raise SystemExit("Relay-SDK HEAD must equal refs/heads/staging")
    return branch, commit


def source_file_hashes(host: str) -> dict[str, str]:
    roots = [
        ROOT / "skills" / "relay",
        DISTRIBUTION_ROOT / "src" / "distribution",
        DISTRIBUTION_ROOT / "src" / "plugins" / host,
    ]
    paths = [
        DISTRIBUTION_ROOT / "LICENSE",
        DISTRIBUTION_ROOT / "scripts" / "build-distribution.py",
        DISTRIBUTION_ROOT / "src" / "plugins" / "version.json",
    ]
    for tree in roots:
        paths.extend(path for path in tree.rglob("*") if path.is_file())
    return {
        str(path.relative_to(ROOT)): sha256(path)
        for path in sorted(set(paths))
    }


def generated_file_hashes(target: Path) -> dict[str, str]:
    return {
        str(path.relative_to(target)): sha256(path)
        for path in sorted(target.rglob("*"))
        if path.is_file()
        and ".git" not in path.parts
        and path.name != ".relay-source.json"
    }


def package_manifest(host: str, version: str) -> dict:
    template = (
        DISTRIBUTION_ROOT / "src" / "distribution" / "package.json"
    ).read_text(encoding="utf-8")
    label = "Codex" if host == "codex" else "Cursor"
    value = json.loads(
        template.replace("{{HOST}}", host).replace("{{HOST_LABEL}}", label)
    )
    value["version"] = version
    common_files = [
        "examples/",
        "scripts/",
        "RELAY_V1_LOCK.json",
        ".relay-source.json",
        "README.md",
        "LICENSE",
    ]
    if host == "codex":
        value["files"] = [".agents/", "plugins/", *common_files]
    else:
        value["files"] = [
            ".cursor-plugin/",
            "skills/",
            "mcp.json",
            *common_files,
        ]
    return value


def build(host: str, target: Path, branch: str, commit: str) -> None:
    clear_target(target)

    version = json.loads(
        (
            DISTRIBUTION_ROOT / "src" / "plugins" / "version.json"
        ).read_text(encoding="utf-8")
    )["version"]
    host_source = DISTRIBUTION_ROOT / "src" / "plugins" / host
    distribution_source = DISTRIBUTION_ROOT / "src" / "distribution"

    shutil.copy2(DISTRIBUTION_ROOT / "LICENSE", target / "LICENSE")
    shutil.copy2(distribution_source / ".gitignore", target / ".gitignore")
    copy_tree(distribution_source / "examples", target / "examples")
    copy_tree(distribution_source / "scripts", target / "scripts")
    shutil.copy2(LOCK_SOURCE, target / "RELAY_V1_LOCK.json")
    write_json(target / "package.json", package_manifest(host, version))

    readme = (host_source / "README.md").read_text(encoding="utf-8")
    (target / "README.md").write_text(
        readme.replace("{{SOURCE_COMMIT}}", commit),
        encoding="utf-8",
    )

    manifest = json.loads(
        (host_source / "plugin.json").read_text(encoding="utf-8")
    )
    manifest["version"] = version
    if (host_source / ".github").exists():
        copy_tree(host_source / ".github", target / ".github")

    if host == "codex":
        plugin = target / "plugins" / "relay"
        (plugin / ".codex-plugin").mkdir(parents=True)
        (target / ".agents" / "plugins").mkdir(parents=True)
        write_json(plugin / ".codex-plugin" / "plugin.json", manifest)
        shutil.copy2(host_source / "mcp.json", plugin / ".mcp.json")
        shutil.copy2(
            host_source / "marketplace.json",
            target / ".agents" / "plugins" / "marketplace.json",
        )
        copy_tree(ROOT / "skills" / "relay", plugin / "skills" / "relay")
    else:
        (target / ".cursor-plugin").mkdir(parents=True)
        write_json(target / ".cursor-plugin" / "plugin.json", manifest)
        shutil.copy2(
            host_source / "marketplace.json",
            target / ".cursor-plugin" / "marketplace.json",
        )
        shutil.copy2(host_source / "mcp.json", target / "mcp.json")
        copy_tree(ROOT / "skills" / "relay", target / "skills" / "relay")

    for path in (target / "scripts").glob("*.mjs"):
        path.chmod(0o755)

    lock = json.loads(LOCK_SOURCE.read_text(encoding="utf-8"))
    provenance = {
        "schema_version": 1,
        "distribution": host,
        "source_repository": SOURCE_REPOSITORY,
        "source_branch": branch,
        "source_commit": commit,
        "generator": "tooling/skills-distributions/scripts/build-distribution.py",
        "relay_v1_lock": lock,
        "source_files": source_file_hashes(host),
        "generated_files": generated_file_hashes(target),
    }
    write_json(target / ".relay-source.json", provenance)


def main() -> None:
    args = parse_args()
    target = Path(args.target).expanduser().resolve()
    if target == ROOT or ROOT in target.parents:
        raise SystemExit("distribution target must be outside Relay-SDK")
    branch, commit = source_identity()
    build(args.host, target, branch, commit)
    print(f"built Relay {args.host} distribution from {commit} into {target}")


if __name__ == "__main__":
    main()
