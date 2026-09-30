"""Shared form vectors and real HTTP transport, following test_selection/test_chats."""
from __future__ import annotations

from copy import deepcopy
import asyncio
import importlib
import json
from pathlib import Path
from typing import Any

import pytest

from relaymessenger import Relay
from test_chats import _Server, server  # noqa: F401 - reuse the HTTP fixture
from test_websocket import FakeRelay, event, ready, recv, relay_server, run_until  # noqa: F401

FIXTURE = json.loads((Path(__file__).parents[3] / "test/fixtures/form-parts.json").read_text())
FORM = FIXTURE["form"]
ANSWERS = FIXTURE["answers"]
TARGET = {"message_id": "01993d50-ef7b-7b37-886b-23fd80c7ec13", "part_index": 1}


def api() -> Any:
    return importlib.import_module("relaymessenger.form")


def build(value: dict[str, Any]) -> Any:
    kwargs = dict(value)
    kwargs.pop("type", None)
    return api().form_part(**kwargs)


@pytest.mark.parametrize("case", [case for case in FIXTURE["cases"] if case["path"] != ["type"]],
                         ids=lambda case: case["name"])
def test_authoring(case: dict[str, Any]) -> None:
    value = deepcopy(FORM)
    parent = value
    for key in case["path"][:-1]:
        parent = parent[key]
    if case.get("remove"):
        del parent[case["path"][-1]]
    else:
        parent[case["path"][-1]] = case["value"]
    # Ensure a missing implementation cannot satisfy an expected ValueError/TypeError.
    api()
    if case["valid"]:
        assert build(value) == value
    else:
        with pytest.raises((ValueError, TypeError)):
            build(value)


def test_normalizes_labels_preserves_placeholders_and_copies_nested_options() -> None:
    value = deepcopy(FORM)
    value["title"] = " Trip details "
    value["pages"][0]["fields"][0]["label"] = " Your name "
    value["pages"][0]["fields"][0]["placeholder"] = "  Required  "
    expected = deepcopy(FORM)
    expected["pages"][0]["fields"][0]["placeholder"] = "  Required  "
    actual = build(value)
    assert actual == expected
    actual["pages"][0]["fields"][2]["options"][0]["label"] = "Changed"
    assert value["pages"][0]["fields"][2]["options"][0]["label"] == "Fall"


@pytest.mark.parametrize("text", [None, "", " \n", " Details please "])
def test_optional_text_and_validation_before_send(text: Any) -> None:
    kwargs = {key: value for key, value in FORM.items() if key != "type"}
    expected = [{"type": "text", "value": text}, FORM] if text and text.strip() else [FORM]
    assert api().form_parts(**kwargs, text=text) == expected
    with pytest.raises(ValueError):
        api().form_parts("Title", [], text=text)


async def test_send_form_and_answer_preserve_identity_on_real_http_retries(server: _Server) -> None:
    relay = Relay("test", base_url=server.base_url, retry_base_delay=0)
    kwargs = {key: value for key, value in FORM.items() if key != "type"}
    server.replies.append((202, {"message": {"id": "prompt", "parts": [FORM]}}))
    await api().send_form(relay, "chat", **kwargs, text="Details", reply_to=TARGET,
                          idempotency_key="prompt-1", silent=True)
    expected = {"message": {
        "parts": [{"type": "text", "value": "Details"}, FORM],
        "reply_to": TARGET, "idempotency_key": "prompt-1", "silent": True,
    }}
    assert server.seen[0][0:2] == ("POST", "/v1/chats/chat/messages")
    assert server.seen[0][3] == expected
    assert server.seen[0][2]["idempotency-key"] == "prompt-1"
    response = {"message": {"parts": [
        {"type": "text", "value": "Form sent"}, {"type": "form_response", "answers": ANSWERS},
    ], "reply_to": TARGET, "idempotency_key": "answer-1"}}
    server.replies += [(503, {"error": {"message": "busy"}}), (202, response)]
    assert await relay.chats.messages.send("chat", response) == response
    assert [request[3] for request in server.seen[1:]] == [response, response]
    assert [request[2]["idempotency-key"] for request in server.seen[1:]] == ["answer-1", "answer-1"]
    with pytest.raises(ValueError):
        await api().send_form(relay, "chat", "Title", [])
    assert len(server.seen) == 3


@pytest.mark.parametrize("answers", [None, ANSWERS])
async def test_history_keeps_viewer_state_and_keyed_answers(server: _Server, answers: Any) -> None:
    part = {**FORM, "has_responded": True, "answers": answers, "reactions": None}
    reply = {"type": "form_response", "answers": ANSWERS}
    page = {"messages": [{"id": "m", "parts": [part, reply], "reply_to": TARGET}], "next_cursor": None}
    server.replies.append((200, page))
    history = await Relay("test", base_url=server.base_url).chats.messages.list("chat")
    assert history == page
    assert api().form_reply(history["messages"][0]["parts"], TARGET) == {"answers": ANSWERS, "reply_to": TARGET}


def test_reply_discovers_field_ids_not_labels_and_copies_arrays() -> None:
    parts = [{"type": "text", "value": "Not machine IDs"}, {"type": "form_response", "answers": deepcopy(ANSWERS)}]
    found = api().form_reply(parts, TARGET)
    assert found == {"answers": ANSWERS, "reply_to": TARGET}
    found["answers"]["name"] = "Changed"
    found["answers"]["interests"].append("Changed")
    assert parts[1]["answers"] == ANSWERS
    for target in (None, {}, {"message_id": "m"}, {"message_id": "", "part_index": 0},
                   {"message_id": "m", "part_index": -1}, {"message_id": "m", "part_index": 0.5},
                   {"message_id": "m", "part_index": True}):
        assert api().form_reply(parts, target) is None
    assert api().form_reply(parts[:1], TARGET) is None
    assert api().form_reply([{"type": "form_response", "answers": {}}], TARGET) == {"answers": {}, "reply_to": TARGET}


async def test_websocket_delivers_keyed_answers_before_ack(relay_server: FakeRelay) -> None:
    api()
    finished = asyncio.get_running_loop().create_future()
    handled = []
    frame = json.loads(event(1))
    frame["event"]["data"] = {"parts": [
        {"type": "text", "value": "Form sent"}, {"type": "form_response", "answers": ANSWERS},
    ], "reply_to": TARGET}

    async def script(connection: Any) -> None:
        await connection.send(ready())
        await connection.send(json.dumps(frame))
        finished.set_result(await recv(connection))

    async def on_event(envelope: Any, context: Any) -> None:
        data = envelope["data"]
        assert data["parts"][0] == {"type": "text", "value": "Form sent"}
        handled.append((api().form_reply(data["parts"], data["reply_to"]), context["sequence"]))

    relay_server.scripts.append(script)
    await run_until(relay_server, finished, on_event=on_event)
    assert handled == [({"answers": ANSWERS, "reply_to": TARGET}, "1")]
    assert finished.result() == {"type": "ack", "through_sequence": "1"}
