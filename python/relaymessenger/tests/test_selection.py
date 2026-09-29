"""Selection prompts: the builder refuses what Relay would refuse, and a send
carries the optional text bubble and the titled selection part."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import pytest

from relaymessenger import selection
from relaymessenger.selection import selection_part, selection_parts, send_selection

OPTIONS = [{"value": "pepperoni", "label": " Crispy Pepperoni "}, {"value": "olives", "label": "Olives"}]
PART = {
    "type": "selection",
    "title": "Pizza toppings",
    "options": [{"value": "pepperoni", "label": "Crispy Pepperoni"}, {"value": "olives", "label": "Olives"}],
}


def test_builds_a_titled_part_with_trimmed_title_and_labels() -> None:
    assert selection_part(" Pizza toppings ", OPTIONS) == PART
    assert selection_part("x" * 60, OPTIONS)["title"] == "x" * 60


def test_text_is_optional() -> None:
    assert selection_parts("Pizza toppings", OPTIONS) == [PART]
    assert selection_parts("Pizza toppings", OPTIONS, text=" \n") == [PART]
    assert selection_parts("Pizza toppings", OPTIONS, text="Build your pizza:") == [
        {"type": "text", "value": "Build your pizza:"},
        PART,
    ]


@pytest.mark.parametrize("title", ["", " \n", "x" * 61, None, 7])
def test_refuses_a_missing_blank_or_long_title(title: Any) -> None:
    with pytest.raises(ValueError, match="title of 1 to 60"):
        selection_part(title, OPTIONS)


@pytest.mark.parametrize(
    "options",
    [
        [],
        [{"value": "x", "label": "X"}] * 26,
        [{"value": "x", "label": "X"}, {"value": "x", "label": "Other"}],
        [{"value": "", "label": "X"}],
        [{"value": " x", "label": "X"}],
        [{"value": "é", "label": "X"}],
        [{"value": "x" * 101, "label": "X"}],
        [{"value": "x", "label": " "}],
        [{"value": "x", "label": "x" * 81}],
        [{"value": "x", "label": "X", "url": "https://example.test"}],
        [{"label": "Never derive a value"}],
        ["x"],
        "xy",
    ],
)
def test_refuses_options_relay_would_refuse(options: Any) -> None:
    with pytest.raises(ValueError):
        selection_part("Pizza toppings", options)


class _Messages:
    def __init__(self) -> None:
        self.sent: List[Tuple[str, Dict[str, Any]]] = []

    async def send(self, chat_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
        self.sent.append((chat_id, body))
        return {"chat_id": chat_id, "message": {"id": "m1", "parts": body["message"]["parts"]}}


class _Relay:
    def __init__(self) -> None:
        self.messages = _Messages()
        self.chats = self


async def test_send_selection_posts_the_optional_text_and_the_part() -> None:
    relay = _Relay()
    await send_selection(relay, "chat", "Pizza toppings", OPTIONS)  # type: ignore[arg-type]
    await send_selection(
        relay,  # type: ignore[arg-type]
        "chat",
        "Pizza toppings",
        OPTIONS,
        text="Build your pizza:",
        reply_to={"message_id": "m0"},
        idempotency_key="k1",
    )
    assert relay.messages.sent == [
        ("chat", {"message": {"parts": [PART]}}),
        (
            "chat",
            {
                "message": {
                    "parts": [{"type": "text", "value": "Build your pizza:"}, PART],
                    "reply_to": {"message_id": "m0"},
                    "idempotency_key": "k1",
                }
            },
        ),
    ]
    with pytest.raises(ValueError, match="title of 1 to 60"):
        await send_selection(relay, "chat", "x" * 61, OPTIONS)  # type: ignore[arg-type]
    assert len(relay.messages.sent) == 2


def test_limits_match_the_contract() -> None:
    assert (selection.SELECTION_TITLE_MAX_LENGTH, selection.SELECTION_MAX_OPTIONS) == (60, 25)
    assert (selection.SELECTION_LABEL_MAX_LENGTH, selection.SELECTION_VALUE_MAX_LENGTH) == (80, 100)
