"""The relaymessenger this package allows has every name it imports."""

from __future__ import annotations

import tomllib
from pathlib import Path

from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[1]
# relaymessenger 0.1.0 is the first release whose relaymessenger.calls exports
# RelayRive and WordTiming, which this package's rive.py imports when it loads.
# 0.1.1 adds the call-speed fixes (bounded relay gathering, 2 s restart connect
# timeout); without them a voice call can wait 5-17 s before it connects.
FIRST_WITH_FAST_CALLS = "0.1.1"


def _core() -> Requirement:
    dependencies = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["dependencies"]
    (core,) = [Requirement(d) for d in dependencies if Requirement(d).name == "relaymessenger"]
    return core


def test_allows_no_relaymessenger_without_fast_calls() -> None:
    core = _core()
    for older in ["0.1.0", "0.1.1rc1", "0.0.9"]:
        assert not core.specifier.contains(older, prereleases=True), older
    assert core.specifier.contains(FIRST_WITH_FAST_CALLS)


def test_allows_the_relaymessenger_in_this_repository() -> None:
    sibling = tomllib.loads((ROOT.parent / "relaymessenger" / "pyproject.toml").read_text())["project"]["version"]
    assert _core().specifier.contains(sibling)
