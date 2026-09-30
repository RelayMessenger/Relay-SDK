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
from urllib.parse import urlsplit
from typing import TYPE_CHECKING, Any, Dict, Final, List, Literal, Mapping, Optional, Sequence, TypedDict, Union, cast

if TYPE_CHECKING:
    from .client import Relay, ReplyTo, SendMessageResponse

SELECTION_TITLE_MAX_LENGTH: Final = 60
SELECTION_MAX_OPTIONS: Final = 25
SELECTION_LABEL_MAX_LENGTH: Final = 80
SELECTION_VALUE_MAX_LENGTH: Final = 100
_VALUE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*", re.ASCII)
_HTTPS_URI = re.compile(r"https://(?:[A-Za-z0-9._~!$&'()*+,;=:%-]*@)?(?:\[[A-Za-z0-9:.-]+\]|[A-Za-z0-9._~!$&'()*+,;=%-]+)(?::[0-9]*)?(?:/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?", re.ASCII)
_INVALID_PERCENT_ESCAPE = re.compile(r"%(?![A-Fa-f0-9]{2})")


class _OptionFields(TypedDict):
    label: str


class _OptionOptional(_OptionFields, total=False):
    subtitle: str
    image_url: str


class SelectionOption(_OptionOptional):
    value: str


class _IdAlias(_OptionOptional, total=False):
    value: str


class SelectionIdOption(_IdAlias):
    id: str


SelectionOptionInput = Union[SelectionOption, SelectionIdOption]


class SelectionOptionResponse(_OptionOptional):
    id: str
    value: str


class SelectionSection(TypedDict):
    title: str
    options: List[SelectionOptionInput]


class SelectionSectionResponse(TypedDict):
    title: str
    options: List[SelectionOptionResponse]


class _ReplyMessageTitle(TypedDict):
    title: str


class SelectionReplyMessage(_ReplyMessageTitle, total=False):
    subtitle: str


class _SelectionRequired(TypedDict):
    type: Literal["selection"]
    title: str


class _SelectionPresentation(_SelectionRequired, total=False):
    subtitle: str
    multiple: bool
    reply_message: SelectionReplyMessage


class SelectionPart(_SelectionPresentation):
    options: List[SelectionOptionInput]


class SelectionSectionedPart(_SelectionPresentation):
    sections: List[SelectionSection]


SelectionPartInput = Union[SelectionPart, SelectionSectionedPart]


class _ResponseSections(_SelectionPresentation, total=False):
    sections: List[SelectionSectionResponse]


class SelectionPartResponse(_ResponseSections):
    options: List[SelectionOptionResponse]
    has_responded: bool
    selected_values: Optional[List[str]]
    selected_ids: Optional[List[str]]
    reactions: None


class _SelectionResponseRequired(TypedDict):
    type: Literal["selection_response"]
    selected_values: List[str]


class SelectionResponsePart(_SelectionResponseRequired, total=False):
    selected_ids: List[str]


class _SelectionResponseIds(_SelectionResponseRequired):
    selected_ids: List[str]


class SelectionResponsePartResponse(_SelectionResponseIds, total=False):
    reply_message: SelectionReplyMessage


class _SelectionReplyRequired(TypedDict):
    selected_values: List[str]
    reply_to: ReplyTo


class SelectionReply(_SelectionReplyRequired, total=False):
    selected_ids: List[str]
    reply_message: SelectionReplyMessage


# Distinguish omitted fields from explicit null; null is not a valid wire value.
_UNSET: Any = object()


def _text(value: Any, maximum: int, name: str, minimum: int = 1) -> str:
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise ValueError(f"{name} needs a trimmed {name} of {minimum} to {maximum} characters")
    return value.strip()


def _reply_message(value: Any) -> SelectionReplyMessage:
    if not isinstance(value, Mapping) or set(value) - {"title", "subtitle"}:
        raise ValueError("reply_message needs title and optional subtitle")
    result: SelectionReplyMessage = {"title": _text(value.get("title"), 512, "title")}
    if "subtitle" in value:
        result["subtitle"] = _text(value["subtitle"], 512, "subtitle", 0)
    return result


def selection_part(
    title: str, options: Sequence[Mapping[str, Any]] = _UNSET, *,
    sections: Sequence[Mapping[str, Any]] = _UNSET,
    subtitle: str = _UNSET, multiple: bool = _UNSET,
    reply_message: Mapping[str, Any] = _UNSET,
) -> SelectionPartInput:
    """Build either flat rows or titled sections; omission keeps multiple=true.

    Legacy value-only rows keep 80-character labels and 100-character tokens.
    ID rows use 200-character identifiers and 24-character labels. Raises
    ValueError instead of truncating or dropping unsupported fields.
    """
    result: Dict[str, Any] = {"type": "selection", "title": _text(title, 60, "title")}
    if (options is _UNSET) == (sections is _UNSET):
        raise ValueError("selection needs exactly one of options or sections")
    if subtitle is not _UNSET:
        result["subtitle"] = _text(subtitle, 512, "subtitle", 0)
    if multiple is not _UNSET:
        if not isinstance(multiple, bool):
            raise ValueError("selection multiple must be boolean")
        result["multiple"] = multiple
    if reply_message is not _UNSET:
        result["reply_message"] = _reply_message(reply_message)
    seen: set[str] = set()

    def rows(items: Any) -> List[SelectionOptionInput]:
        if not isinstance(items, Sequence) or isinstance(items, (str, bytes)) or not 1 <= len(items) <= 25:
            raise ValueError("selection needs 1 to 25 options")
        output: List[SelectionOptionInput] = []
        for option in items:
            if not isinstance(option, Mapping) or set(option) - {"id", "value", "label", "subtitle", "image_url"}:
                raise ValueError("option is not an object or has unknown fields")
            value = option.get("value")
            if "id" in option:
                identifier = option["id"]
                if not isinstance(identifier, str) or not 1 <= len(identifier) <= 200:
                    raise ValueError("option id needs 1 to 200 characters")
                if "value" in option and value != identifier:
                    raise ValueError("option id and value must match")
            else:
                if not isinstance(value, str) or len(value) > 100 or not _VALUE.fullmatch(value):
                    raise ValueError("option needs an ASCII token value of 1 to 100 characters")
                identifier = value
            if identifier in seen:
                raise ValueError(f"duplicate selection value {identifier}")
            seen.add(identifier)
            if len(seen) > 25:
                raise ValueError("selection needs at most 25 total options")
            row = dict(option)
            row["label"] = _text(option.get("label"), 24 if "id" in option else 80, "label")
            if "subtitle" in option:
                row["subtitle"] = _text(option["subtitle"], 72, "subtitle", 0)
            if "image_url" in option:
                url = option["image_url"]
                if (not isinstance(url, str) or len(url) > 2048 or not url.startswith("https://")
                    or not _HTTPS_URI.fullmatch(url) or _INVALID_PERCENT_ESCAPE.search(url)):
                    raise ValueError("option image_url needs HTTPS, at most 2048 characters")
                try:
                    parsed = urlsplit(url)
                    if not parsed.hostname:
                        raise ValueError("missing host")
                    parsed.port  # refuse malformed ports
                except ValueError as error:
                    raise ValueError("option image_url needs a valid HTTPS URL") from error
            output.append(cast(SelectionOptionInput, row))
        return output

    if options is not _UNSET:
        result["options"] = rows(options)
    else:
        if not isinstance(sections, Sequence) or isinstance(sections, (str, bytes)) or not 1 <= len(sections) <= 10:
            raise ValueError("selection needs 1 to 10 sections")
        groups: List[SelectionSection] = []
        for section in sections:
            if not isinstance(section, Mapping) or set(section) - {"title", "options"}:
                raise ValueError("section is not an object or has unknown fields")
            groups.append({"title": _text(section.get("title"), 24, "section title"), "options": rows(section.get("options"))})
        result["sections"] = groups
    return cast(SelectionPartInput, result)


def selection_reply(
    parts: Sequence[Mapping[str, Any]], reply_to: Optional[ReplyTo] = None,
) -> Optional[SelectionReply]:
    """Read authoritative metadata, never labels; keep legacy replies valid."""
    if not reply_to or not reply_to.get("message_id"):
        return None
    index = reply_to.get("part_index")
    if type(index) is not int or index < 0:
        return None
    response = next((part for part in parts if part.get("type") == "selection_response"), None)
    if response is None:
        return None
    result: SelectionReply = {"selected_values": list(response["selected_values"]),
        "reply_to": {"message_id": reply_to["message_id"], "part_index": index}}
    if "selected_ids" in response:
        result["selected_ids"] = list(response["selected_ids"])
    if "reply_message" in response:
        result["reply_message"] = cast(SelectionReplyMessage, dict(response["reply_message"]))
    return result


def selection_parts(
    title: str, options: Sequence[Mapping[str, Any]] = _UNSET, *, text: Optional[str] = None,
    sections: Sequence[Mapping[str, Any]] = _UNSET, subtitle: str = _UNSET,
    multiple: bool = _UNSET, reply_message: Mapping[str, Any] = _UNSET,
) -> List[Dict[str, Any]]:
    """A message's parts: ``text`` as a bubble above the card when it has words,
    then the selection. With no ``text`` the selection is sent alone."""
    part = selection_part(title, options, sections=sections, subtitle=subtitle, multiple=multiple, reply_message=reply_message)
    parts: List[Dict[str, Any]] = []
    if text is not None and text.strip():
        parts.append({"type": "text", "value": text})
    parts.append(dict(part))
    return parts


async def send_selection(
    relay: Relay,
    chat_id: str,
    title: str,
    options: Sequence[Mapping[str, Any]] = _UNSET,
    *,
    text: Optional[str] = None,
    sections: Sequence[Mapping[str, Any]] = _UNSET,
    subtitle: str = _UNSET, multiple: bool = _UNSET, reply_message: Mapping[str, Any] = _UNSET,
    reply_to: Optional[ReplyTo] = None,
    idempotency_key: Optional[str] = None,
    silent: Optional[bool] = None,
) -> SendMessageResponse:
    """Send a selection to a chat, after an optional ``text`` bubble."""
    message: Dict[str, Any] = {"parts": selection_parts(title, options, text=text, sections=sections, subtitle=subtitle, multiple=multiple, reply_message=reply_message)}
    if reply_to is not None:
        message["reply_to"] = dict(reply_to)
    if idempotency_key is not None:
        message["idempotency_key"] = idempotency_key
    if silent is not None:
        message["silent"] = silent
    return await relay.chats.messages.send(chat_id, {"message": message})
