"""Selection prompts: a multi-select card the person answers once.

The twin of ``@relaymessenger/sdk``'s ``selectionPart`` and
``partsWithSelection`` (``SelectionPart`` in contracts/relay-v1-openapi.yaml).
The question is the part's ``title``: trimmed, 1 to 60 characters, the card's
title in the chat and the sheet's title. A text part is optional; when present
it is an ordinary chat bubble above the card. One selection per message, never
with buttons.

The person's answer arrives as a ``message.received`` whose parts are the text
``"• " + label`` lines joined with ``"\\n"`` and a ``selection_response`` part
whose ``selected_values`` are the chosen values in source-option order, with
``reply_to`` naming the prompt. Dispatch on those values, never on the labels.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Dict, Final, List, Literal, Mapping, Optional, Sequence, TypedDict

if TYPE_CHECKING:
    from .client import Relay, ReplyTo, SendMessageResponse

SELECTION_TITLE_MAX_LENGTH: Final = 60
SELECTION_MAX_OPTIONS: Final = 25
SELECTION_LABEL_MAX_LENGTH: Final = 80
SELECTION_VALUE_MAX_LENGTH: Final = 100
_VALUE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*", re.ASCII)


class SelectionOption(TypedDict):
    #: Unique case-sensitive ASCII token, 1 to 100 characters. Never derived from the label.
    value: str
    #: Trimmed visible label, 1 to 80 characters.
    label: str


class SelectionPart(TypedDict):
    type: Literal["selection"]
    #: The question. Trimmed, 1 to 60 characters.
    title: str
    options: List[SelectionOption]


def selection_part(title: str, options: Sequence[Mapping[str, Any]]) -> SelectionPart:
    """The ``selection`` part for ``title`` and ``options``, with the title and
    labels trimmed. Raises :class:`ValueError` for anything Relay would refuse."""
    if not isinstance(title, str) or not title.strip() or len(title.strip()) > SELECTION_TITLE_MAX_LENGTH:
        raise ValueError(f"selection needs a trimmed title of 1 to {SELECTION_TITLE_MAX_LENGTH} characters")
    if isinstance(options, (str, bytes)) or not 1 <= len(options) <= SELECTION_MAX_OPTIONS:
        raise ValueError(f"selection needs 1 to {SELECTION_MAX_OPTIONS} options")
    seen = set()
    result: List[SelectionOption] = []
    for index, option in enumerate(options, start=1):
        if not isinstance(option, Mapping):
            raise ValueError(f"option {index} is not an object")
        extra = next((key for key in option if key not in ("value", "label")), None)
        if extra is not None:
            raise ValueError(f"option {index} has unknown field {extra}")
        value, label = option.get("value"), option.get("label")
        if not isinstance(value, str) or len(value) > SELECTION_VALUE_MAX_LENGTH or not _VALUE.fullmatch(value):
            raise ValueError(
                f"option {index} needs an ASCII token value of 1 to {SELECTION_VALUE_MAX_LENGTH} characters"
            )
        if value in seen:
            raise ValueError(f"duplicate selection value {value}")
        if not isinstance(label, str) or not label.strip() or len(label.strip()) > SELECTION_LABEL_MAX_LENGTH:
            raise ValueError(f"option {index} needs a trimmed label of 1 to {SELECTION_LABEL_MAX_LENGTH} characters")
        seen.add(value)
        result.append({"value": value, "label": label.strip()})
    return {"type": "selection", "title": title.strip(), "options": result}


def selection_parts(
    title: str, options: Sequence[Mapping[str, Any]], *, text: Optional[str] = None
) -> List[Dict[str, Any]]:
    """A message's parts: ``text`` as a bubble above the card when it has words,
    then the selection. With no ``text`` the selection is sent alone."""
    part = selection_part(title, options)
    parts: List[Dict[str, Any]] = []
    if text is not None and text.strip():
        parts.append({"type": "text", "value": text})
    parts.append(dict(part))
    return parts


async def send_selection(
    relay: Relay,
    chat_id: str,
    title: str,
    options: Sequence[Mapping[str, Any]],
    *,
    text: Optional[str] = None,
    reply_to: Optional[ReplyTo] = None,
    idempotency_key: Optional[str] = None,
    silent: Optional[bool] = None,
) -> SendMessageResponse:
    """Send a selection to a chat, after an optional ``text`` bubble."""
    message: Dict[str, Any] = {"parts": selection_parts(title, options, text=text)}
    if reply_to is not None:
        message["reply_to"] = dict(reply_to)
    if idempotency_key is not None:
        message["idempotency_key"] = idempotency_key
    if silent is not None:
        message["silent"] = silent
    return await relay.chats.messages.send(chat_id, {"message": message})
