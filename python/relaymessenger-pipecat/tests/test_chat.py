"""relay_chat_tools and load_chat_context against a fake Relay client: each
tool makes the right SDK call with the SDK's own parts. No network."""

from __future__ import annotations

from typing import Any, Optional

import pytest
from pipecat.services.llm_service import FunctionCallParams

from relaymessenger_pipecat import load_chat_context, relay_chat_tools

CHAT = "chat_1"


class FakeMessages:
    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.listed: list[tuple[str, dict[str, Any]]] = []
        self.page: dict[str, Any] = {"messages": []}
        self.error: Optional[Exception] = None

    async def send(self, chat_id: str, body: dict[str, Any]) -> dict[str, Any]:
        if self.error:
            raise self.error
        self.sent.append((chat_id, body))
        return {"message": {"id": f"msg_{len(self.sent)}"}}

    async def list(self, chat_id: str, **kwargs: Any) -> dict[str, Any]:
        self.listed.append((chat_id, kwargs))
        return self.page


class FakeLocation:
    def __init__(self) -> None:
        self.requested: list[str] = []
        self.retrieved: list[str] = []

    async def request(self, chat_id: str) -> dict[str, Any]:
        self.requested.append(chat_id)
        return {"success": True, "message": "requested"}

    async def retrieve(self, chat_id: str) -> dict[str, Any]:
        self.retrieved.append(chat_id)
        return {
            "success": True,
            "data": {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [-83.74, 42.28]},
                        "properties": {"handle": "+15550100"},
                    }
                ],
            },
        }


class FakeChats:
    def __init__(self) -> None:
        self.messages = FakeMessages()
        self.location = FakeLocation()


class FakeRelay:
    def __init__(self) -> None:
        self.chats = FakeChats()


class FakeLLM:
    def __init__(self) -> None:
        self.registered: dict[str, Any] = {}

    def register_function(self, name: str, handler: Any) -> None:
        self.registered[name] = handler


async def call(relay: FakeRelay, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    llm = FakeLLM()
    relay_chat_tools(relay, CHAT).register(llm)  # type: ignore[arg-type]
    results: list[dict[str, Any]] = []

    async def result_callback(result: Any, **_: Any) -> None:
        results.append(result)

    params = FunctionCallParams(
        function_name=name,
        tool_call_id="call_7",
        arguments=arguments,
        llm=llm,  # type: ignore[arg-type]
        pipeline_worker=None,  # type: ignore[arg-type]
        context=None,  # type: ignore[arg-type]
        result_callback=result_callback,
    )
    await llm.registered[name](params)
    assert len(results) == 1
    return results[0]


def only_message(relay: FakeRelay) -> dict[str, Any]:
    [(chat_id, body)] = relay.chats.messages.sent
    assert chat_id == CHAT
    assert body["message"]["idempotency_key"] == f"relay-pipecat:{CHAT}:call_7"
    return dict(body["message"])


def test_schema_and_registration_cover_every_tool() -> None:
    names = ["send_message", "send_buttons", "send_selection", "send_place", "request_location", "read_location", "send_link"]
    tools = relay_chat_tools(FakeRelay(), CHAT)  # type: ignore[arg-type]
    assert [t.name for t in tools.tools.standard_tools] == names
    llm = FakeLLM()
    tools.register(llm)
    assert list(llm.registered) == names


async def test_send_message_sends_a_text_part_with_reply() -> None:
    relay = FakeRelay()
    result = await call(relay, "send_message", {"text": "Gate 4", "reply_to_message_id": "msg_0"})
    assert result == {"status": "sent", "message_id": "msg_1"}
    message = only_message(relay)
    assert message["parts"] == [{"type": "text", "value": "Gate 4"}]
    assert message["reply_to"] == {"message_id": "msg_0"}


async def test_send_buttons_sends_question_then_buttons() -> None:
    relay = FakeRelay()
    await call(relay, "send_buttons", {"text": "Which day?", "buttons": [{"label": "Today"}, {"label": "Site", "url": "https://example.com"}]})
    assert only_message(relay)["parts"] == [
        {"type": "text", "value": "Which day?"},
        {"type": "buttons", "items": [{"label": "Today"}, {"label": "Site", "url": "https://example.com"}]},
    ]


async def test_send_selection_sends_a_selection_part() -> None:
    relay = FakeRelay()
    await call(relay, "send_selection", {
        "title": "Pick a time",
        "options": [{"id": "t9", "label": "9 AM"}, {"id": "t10", "label": "10 AM", "subtitle": "busy"}],
        "multiple": False,
        "text": "Here are the slots",
    })
    assert only_message(relay)["parts"] == [
        {"type": "text", "value": "Here are the slots"},
        {"type": "selection", "title": "Pick a time", "multiple": False, "options": [
            {"id": "t9", "label": "9 AM"},
            {"id": "t10", "label": "10 AM", "subtitle": "busy"},
        ]},
    ]


async def test_send_place_sends_a_place_part() -> None:
    relay = FakeRelay()
    await call(relay, "send_place", {"latitude": 42.28, "longitude": -83.74, "name": "Diag"})
    assert only_message(relay)["parts"] == [{"type": "place", "latitude": 42.28, "longitude": -83.74, "name": "Diag"}]


async def test_send_link_sends_a_link_part_alone() -> None:
    relay = FakeRelay()
    await call(relay, "send_link", {"url": "https://relayapp.im"})
    assert only_message(relay)["parts"] == [{"type": "link", "value": "https://relayapp.im"}]


async def test_request_location_asks_the_chat() -> None:
    relay = FakeRelay()
    assert await call(relay, "request_location", {}) == {"status": "requested"}
    assert relay.chats.location.requested == [CHAT]
    assert relay.chats.messages.sent == []


async def test_read_location_returns_latitude_and_longitude() -> None:
    relay = FakeRelay()
    result = await call(relay, "read_location", {})
    assert relay.chats.location.retrieved == [CHAT]
    assert result == {"status": "ok", "locations": [{"latitude": 42.28, "longitude": -83.74, "handle": "+15550100"}]}


async def test_invalid_part_is_reported_to_the_model_not_sent() -> None:
    relay = FakeRelay()
    result = await call(relay, "send_buttons", {"text": "?", "buttons": [{"label": str(i)} for i in range(6)]})
    assert result["status"] == "failed"
    assert relay.chats.messages.sent == []


async def test_send_failure_is_reported_to_the_model() -> None:
    relay = FakeRelay()
    relay.chats.messages.error = RuntimeError("422")
    assert await call(relay, "send_message", {"text": "hi"}) == {"status": "failed", "error": "422"}


async def test_load_chat_context_is_oldest_first_with_roles() -> None:
    relay = FakeRelay()
    relay.chats.messages.page = {"messages": [
        {"id": "m3", "is_from_me": True, "parts": [{"type": "text", "value": "See you there"}, {"type": "place", "latitude": 1, "longitude": 2, "name": "Diag"}]},
        {"id": "m2", "is_from_me": False, "parts": [{"type": "text", "value": "where?"}]},
        {"id": "m1", "is_from_me": False, "parts": []},
    ]}
    context = await load_chat_context(relay, CHAT, limit=5)  # type: ignore[arg-type]
    assert relay.chats.messages.listed == [(CHAT, {"limit": 5, "order": "desc"})]
    assert context == [
        {"role": "user", "content": "where?"},
        {"role": "assistant", "content": "See you there\n[place: Diag]"},
    ]


@pytest.mark.parametrize("bad", [{"latitude": 91, "longitude": 0}])
async def test_place_out_of_range_is_refused(bad: dict[str, Any]) -> None:
    relay = FakeRelay()
    assert (await call(relay, "send_place", bad))["status"] == "failed"
    assert relay.chats.messages.sent == []
