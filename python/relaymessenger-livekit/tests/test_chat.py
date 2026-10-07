"""The call's chat tools and chat context, run the way LiveKit Agents runs them,
against a fake Relay client: no network."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest
from livekit.agents import Agent, RunContext
from livekit.agents.llm import FunctionCall, RawFunctionTool, ToolError
from livekit.agents.llm.utils import prepare_function_arguments

from relaymessenger_livekit import CHAT_TOOL_NAMES, load_chat_context, relay_chat_tools


class FakeMessages:
    def __init__(self, page: List[Dict[str, Any]] | None = None) -> None:
        self.sent: List[tuple[str, Dict[str, Any]]] = []
        self.listed: List[Dict[str, Any]] = []
        self.page = page or []

    async def send(self, chat_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
        self.sent.append((chat_id, body))
        return {"chat_id": chat_id, "message": {"id": "msg_1"}}

    async def list(self, chat_id: str, **query: Any) -> Dict[str, Any]:
        self.listed.append({"chat_id": chat_id, **query})
        return {"messages": self.page, "next_cursor": None}


class FakeLocation:
    def __init__(self, features: List[Dict[str, Any]]) -> None:
        self.features = features
        self.requested: List[str] = []

    async def request(self, chat_id: str) -> Dict[str, Any]:
        self.requested.append(chat_id)
        return {"success": True, "message": "sent"}

    async def retrieve(self, chat_id: str) -> Dict[str, Any]:
        return {"success": True, "data": {"type": "FeatureCollection", "features": self.features}}


def fake_relay(page: List[Dict[str, Any]] | None = None, features: List[Dict[str, Any]] | None = None) -> Any:
    return SimpleNamespace(chats=SimpleNamespace(messages=FakeMessages(page), location=FakeLocation(features or [])))


def run_context(call_id: str = "call_7") -> RunContext[Any]:
    call = FunctionCall(call_id=call_id, arguments="{}", name="tool")
    return RunContext(session=SimpleNamespace(_global_run_state=None), speech_handle=SimpleNamespace(num_steps=1), function_call=call)  # type: ignore[arg-type]


async def call(relay: Any, name: str, arguments: Dict[str, Any]) -> Any:
    """Calls the tool the way LiveKit's tool executor does: JSON arguments in,
    RunContext injected by type."""
    tool = {t.info.name: t for t in relay_chat_tools(relay, "chat_1")}[name]
    args, kwargs = prepare_function_arguments(fnc=tool, json_arguments=json.dumps(arguments), call_ctx=run_context())
    return await tool(*args, **kwargs)


def sent_parts(relay: Any) -> List[Dict[str, Any]]:
    ((chat_id, body),) = relay.chats.messages.sent
    assert chat_id == "chat_1"
    assert body["message"]["idempotency_key"] == "livekit:chat_1:call_7"
    return list(body["message"]["parts"])


def test_the_seven_tools_are_raw_livekit_tools_an_agent_takes() -> None:
    tools = relay_chat_tools(fake_relay(), "chat_1")
    assert all(isinstance(tool, RawFunctionTool) for tool in tools)
    assert tuple(tool.info.name for tool in tools) == CHAT_TOOL_NAMES == (
        "send_message", "send_buttons", "send_selection", "send_place", "request_location", "read_location", "send_link",
    )
    agent = Agent(instructions="x", tools=tools)
    assert {tool.info.name for tool in agent.tools} == set(CHAT_TOOL_NAMES)  # type: ignore[union-attr]


async def test_send_message_texts_the_trimmed_words() -> None:
    relay = fake_relay()
    assert await call(relay, "send_message", {"text": "  see you at 6 "}) == {"status": "sent", "message_id": "msg_1"}
    assert sent_parts(relay) == [{"type": "text", "value": "see you at 6"}]


async def test_send_message_replies_to_the_given_message() -> None:
    relay = fake_relay()
    await call(relay, "send_message", {"text": "yes, that one", "reply_to_message_id": "msg_0"})
    ((_, body),) = relay.chats.messages.sent
    assert body["message"]["reply_to"] == {"message_id": "msg_0"}
    assert body["message"]["parts"] == [{"type": "text", "value": "yes, that one"}]
    plain = fake_relay()
    await call(plain, "send_message", {"text": "hi"})
    assert "reply_to" not in plain.chats.messages.sent[0][1]["message"]


async def test_send_message_refuses_empty_text_without_sending() -> None:
    relay = fake_relay()
    with pytest.raises(ToolError):
        await call(relay, "send_message", {"text": "  "})
    assert relay.chats.messages.sent == []


async def test_send_buttons_sends_the_question_and_its_buttons() -> None:
    relay = fake_relay()
    await call(relay, "send_buttons", {"text": "Book it?", "buttons": [{"label": "Yes"}, {"label": "Menu", "url": "https://a.example/m"}]})
    assert sent_parts(relay) == [
        {"type": "text", "value": "Book it?"},
        {"type": "buttons", "items": [{"label": "Yes"}, {"label": "Menu", "url": "https://a.example/m"}]},
    ]


async def test_send_buttons_refusal_from_the_sdk_reaches_the_model() -> None:
    relay = fake_relay()
    with pytest.raises(ToolError, match="1 to 5"):
        await call(relay, "send_buttons", {"text": "Pick", "buttons": [{"label": str(n)} for n in range(6)]})
    assert relay.chats.messages.sent == []


async def test_send_selection_sends_words_then_the_selection() -> None:
    relay = fake_relay()
    await call(relay, "send_selection", {
        "title": "Toppings", "text": "Pick yours", "multiple": False,
        "options": [{"value": "cheese", "label": "Cheese"}, {"value": "olive", "label": "Olives"}],
    })
    assert sent_parts(relay) == [
        {"type": "text", "value": "Pick yours"},
        {"type": "selection", "title": "Toppings", "multiple": False,
         "options": [{"value": "cheese", "label": "Cheese"}, {"value": "olive", "label": "Olives"}]},
    ]


async def test_send_selection_refuses_a_duplicate_value() -> None:
    relay = fake_relay()
    with pytest.raises(ToolError, match="duplicate"):
        await call(relay, "send_selection", {"title": "T", "options": [{"value": "a", "label": "A"}, {"value": "a", "label": "B"}]})


async def test_send_place_sends_a_place_part() -> None:
    relay = fake_relay()
    await call(relay, "send_place", {"latitude": 42.28, "longitude": -83.74, "name": " Zingerman's "})
    assert sent_parts(relay) == [{"type": "place", "latitude": 42.28, "longitude": -83.74, "name": "Zingerman's"}]


async def test_send_place_refuses_an_impossible_latitude() -> None:
    with pytest.raises(ToolError):
        await call(fake_relay(), "send_place", {"latitude": 91, "longitude": 0})


async def test_send_link_sends_a_link_part_and_refuses_other_schemes() -> None:
    relay = fake_relay()
    await call(relay, "send_link", {"url": "https://relayapp.im"})
    assert sent_parts(relay) == [{"type": "link", "value": "https://relayapp.im"}]
    with pytest.raises(ToolError):
        await call(fake_relay(), "send_link", {"url": "javascript:alert(1)"})


async def test_request_location_asks_relay_for_this_chat() -> None:
    relay = fake_relay()
    assert await call(relay, "request_location", {}) == {"status": "requested"}
    assert relay.chats.location.requested == ["chat_1"]


async def test_read_location_reads_longitude_latitude_order_right() -> None:
    feature = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-83.74, 42.28]},
               "properties": {"handle": "+15550001", "updated_at": "2026-10-07T12:00:00Z"}}
    assert await call(fake_relay(features=[feature]), "read_location", {}) == {
        "status": "sharing",
        "locations": [{"handle": "+15550001", "latitude": 42.28, "longitude": -83.74, "updated_at": "2026-10-07T12:00:00Z"}],
    }
    assert await call(fake_relay(), "read_location", {}) == {"status": "not_sharing"}


async def test_load_chat_context_reads_the_newest_page_oldest_first() -> None:
    page = [  # newest first, as order="desc" returns them
        {"id": "m3", "is_from_me": True, "parts": [{"type": "place", "latitude": 1, "longitude": 2, "name": "Cafe"}]},
        {"id": "m2", "is_from_me": False, "is_system_message": True, "parts": [{"type": "text", "value": "joined"}]},
        {"id": "m1", "is_from_me": False, "parts": [{"type": "text", "value": "where?"}]},
    ]
    relay = fake_relay(page=page)
    context = await load_chat_context(relay, "chat_1", limit=5)
    assert relay.chats.messages.listed == [{"chat_id": "chat_1", "limit": 5, "order": "desc"}]
    assert [(item.id, item.role, item.text_content) for item in context.messages()] == [
        ("m1", "user", "where?"),
        ("m3", "assistant", "[place: Cafe]"),
    ]
