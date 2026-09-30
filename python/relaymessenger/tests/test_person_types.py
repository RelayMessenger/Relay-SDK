"""The person types say what the carried contract defines, a person's time zone included."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from relaymessenger import ChatHandle, ContactCard, ContactEventContact

CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "relay-v1-openapi.yaml"


def _properties(name: str) -> list[str]:
    """The property names of one ``components.schemas`` entry in the carried contract."""
    text = CONTRACT.read_text()
    start = text.index(f"\n    {name}:\n") + 1
    following = re.search(r"\n    [A-Za-z0-9]+:\n", text[start + 1 :])
    schema = text[start : start + 1 + following.start() + 1] if following else text[start:]
    return re.findall(r"^        ([a-z_]+):$", schema[schema.index("      properties:\n") :], re.M)


@pytest.mark.parametrize(
    ("typed", "schema"),
    [(ChatHandle, "ChatHandle"), (ContactEventContact, "ContactEventContact"), (ContactCard, "ContactLookup")],
)
def test_a_person_type_names_every_contract_field(typed: type, schema: str) -> None:
    assert "timezone" in _properties(schema)
    assert sorted(typed.__annotations__) == sorted(_properties(schema))


def test_a_contact_event_contact_always_carries_the_time_zone_key() -> None:
    assert "timezone" in ContactEventContact.__required_keys__
