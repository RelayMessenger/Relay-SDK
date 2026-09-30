"""Shared TS/Python wire cases; no invented contract fixture."""
import copy
import json
from pathlib import Path

import pytest
from relaymessenger import selection

FIXTURES = json.loads((Path(__file__).resolve().parents[3] / "test/fixtures/list-picker.json").read_text())

@pytest.mark.parametrize("case", FIXTURES["valid"], ids=lambda case: case["name"])
def test_valid(case):
    args = {k: v for k, v in case["input"].items() if k != "type"}
    assert selection.selection_part(**args) == case["expected"]
    assert selection.selection_parts(**args) == [case["expected"]]

@pytest.mark.parametrize("case", FIXTURES["invalid"], ids=lambda case: case["name"])
def test_invalid(case):
    with pytest.raises((ValueError, TypeError)):
        selection.selection_part(**case["input"])

def test_reply_parser_ids_and_source_owned_text():
    parts = [{"type": "text", "value": "• Same"}, {"type": "selection_response", "selected_values": ["a / 1"], "selected_ids": ["a / 1"], "reply_message": {"title": "Saved", "subtitle": "Thanks"}}]
    before = copy.deepcopy(parts)
    source = {"message_id": "source", "part_index": 0}
    result = selection.selection_reply(parts, source)
    assert result == {"selected_values": ["a / 1"], "selected_ids": ["a / 1"], "reply_message": {"title": "Saved", "subtitle": "Thanks"}, "reply_to": source}
    result["selected_ids"].append("local")
    result["reply_message"]["title"] = "local"
    assert parts == before
    for target in [None, {"message_id": "source"}, {"message_id": "source", "part_index": -1}, {"message_id": "source", "part_index": True}]:
        assert selection.selection_reply(parts, target) is None
    assert selection.selection_reply(parts[:1], source) is None
    assert selection.selection_reply([{"type": "selection_response", "selected_values": ["legacy"]}], source) == {"selected_values": ["legacy"], "reply_to": source}

async def test_send_preserves_new_fields():
    class Messages:
        async def send(self, chat_id, body):
            assert chat_id == "chat"
            return body
    class Relay:
        messages = Messages()
        @property
        def chats(self): return self
    case = FIXTURES["valid"][1]
    result = await selection.send_selection(Relay(), "chat", **case["input"], text="Choose", idempotency_key="stable", silent=False)
    assert result == {"message": {"parts": [{"type": "text", "value": "Choose"}, case["expected"]], "idempotency_key": "stable", "silent": False}}

def test_legacy_typed_dict_constructors_still_work():
    option = selection.SelectionOption(value="legacy", label="L" * 80)
    part = selection.SelectionPart(type="selection", title="Legacy", options=[option])
    assert selection.selection_part("Legacy", [option]) == part
