"""Every message part an agent sends or reads: the twin of ``MessagePart`` and
the ``*Part`` types in ``@relaymessenger/sdk`` (``TextPart``, ``MediaPart``,
``LinkPart``, ``ButtonsPart``, ``PlacePart``, ``PaymentPart`` and the
selection, form, rich card and carousel parts), as
contracts/relay-v1-openapi.yaml names them.

A message's ``parts`` is a list of these dicts; ``chats.messages.send`` and
``messages.create`` take them as they are. The selection, form and rich card
modules keep their builders and readers; this module gathers every part type in
one place and adds the ones that had none.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Tuple, TypedDict, Union
from urllib.parse import urlsplit

from .form_types import FormPart, FormResponsePart
from .rich_cards import CarouselPart, RichCardPart, SuggestionResponsePart
from .selection import SelectionPart, SelectionResponsePart, SelectionSectionedPart

#: The reactions a person or agent can leave on a message part.
ReactionType = Literal["love", "like", "dislike", "laugh", "emphasize", "question", "custom"]


class _TextPartRequired(TypedDict):
    type: Literal["text"]
    value: str


class TextPart(_TextPartRequired, total=False):
    """Plain text, 1 to 10000 characters. A mention names one chat member:
    ``mention`` is their handle and ``mention_range`` the ``[start, end)`` of
    the mention in ``value``, in UTF-16 code units; without a range the mention
    covers the whole value."""

    mention: Optional[str]
    mention_range: Optional[Tuple[int, int]]


class _MediaPartRequired(TypedDict):
    type: Literal["media"]


class MediaPart(_MediaPartRequired, total=False):
    """A file: a public ``url``, or the ``attachment_id`` of an upload from
    ``attachments.create``. Send one of the two."""

    url: str
    attachment_id: str


class LinkPart(TypedDict):
    """A URL shown as a rich link preview."""

    type: Literal["link"]
    value: str


class _ButtonItemRequired(TypedDict):
    label: str


class ButtonItem(_ButtonItemRequired, total=False):
    """One button: a label of at most 80 characters and, for a link button,
    an http or https ``url``. A button without ``url`` sends its label back as text."""

    url: str


class ButtonsPart(TypedDict):
    """Up to 5 buttons under the message."""

    type: Literal["buttons"]
    items: List[ButtonItem]


class _PlacePartRequired(TypedDict):
    type: Literal["place"]
    latitude: float
    longitude: float


class PlacePart(_PlacePartRequired, total=False):
    """A pin on a map, with an optional name and address (each trimmed, 1 to 256 characters)."""

    name: str
    address: str


class PaymentPart(TypedDict):
    """A payment card: the ``checkout_url`` of a payment request from
    ``payment_requests.create``."""

    type: Literal["payment"]
    checkout_url: str


class RatingRequestPart(TypedDict):
    """Ask a person to rate the sending agent. This is the whole Message."""

    type: Literal["rating_request"]


class RatingRequestRating(TypedDict):
    stars: Literal[1, 2, 3, 4, 5]
    review: Optional[str]


class RatingRequestPartResponse(RatingRequestPart):
    """Only this reader's own rating, never another person's."""

    rating: Optional[RatingRequestRating]
    reactions: Optional[List[Dict[str, Any]]]


def rating_request_part() -> RatingRequestPart:
    """Send alone: {"type": "rating_request"}; words/target are server-owned."""
    return {"type": "rating_request"}


#: Any part an agent may send.
MessagePart = Union[
    TextPart,
    MediaPart,
    LinkPart,
    ButtonsPart,
    SelectionPart,
    SelectionSectionedPart,
    SelectionResponsePart,
    RichCardPart,
    CarouselPart,
    SuggestionResponsePart,
    FormPart,
    FormResponsePart,
    PaymentPart,
    RatingRequestPart,
    PlacePart,
]


class _ReplyToRequired(TypedDict):
    message_id: str


class MessageReplyTo(_ReplyToRequired, total=False):
    part_index: int


class _MessageContentRequired(TypedDict):
    parts: List[MessagePart]


class MessageContent(_MessageContentRequired, total=False):
    """A message to send (contract ``MessageContent``). ``silent`` sends it
    with no banner and no sound; ``idempotency_key`` makes the send safe to
    retry."""

    reply_to: MessageReplyTo
    idempotency_key: str
    silent: bool


def text_part(value: str, *, mention: Optional[str] = None, mention_range: Optional[Tuple[int, int]] = None) -> TextPart:
    """A text part. ``mention_range`` is ``(start, end)`` in UTF-16 code units
    and needs ``mention``; a mention without a range covers the whole value."""
    if mention_range is not None:
        if mention is None:
            raise ValueError("mention_range needs mention.")
        start, end = mention_range
        if not 0 <= start < end <= len(value.encode("utf-16-le")) // 2:
            raise ValueError("mention_range is a [start, end) range inside value, in UTF-16 code units.")
    part: TextPart = {"type": "text", "value": value}
    if mention is not None:
        part["mention"] = mention
    if mention_range is not None:
        part["mention_range"] = mention_range
    return part


def media_part(*, url: Optional[str] = None, attachment_id: Optional[str] = None) -> MediaPart:
    """A media part from a public URL or an uploaded attachment, not both."""
    if (url is None) == (attachment_id is None):
        raise ValueError("media_part takes url or attachment_id, exactly one.")
    if url is not None:
        return {"type": "media", "url": url}
    assert attachment_id is not None
    return {"type": "media", "attachment_id": attachment_id}


def link_part(url: str) -> LinkPart:
    return {"type": "link", "value": url}


#: ``buttons.ts``: at most 5 buttons, labels of at most 80 characters, URLs of at most 2048.
BUTTONS_MAX_ITEMS = 5
BUTTON_LABEL_MAX_LENGTH = 80
BUTTON_URL_MAX_LENGTH = 2048


def buttons_part(items: List[ButtonItem]) -> ButtonsPart:
    """A buttons part, checked against the TypeScript SDK's limits."""
    if not 1 <= len(items) <= BUTTONS_MAX_ITEMS:
        raise ValueError(f"A buttons part takes 1 to {BUTTONS_MAX_ITEMS} buttons.")
    checked: List[ButtonItem] = []
    for item in items:
        label = item.get("label")
        if not isinstance(label, str) or not label or len(label) > BUTTON_LABEL_MAX_LENGTH:
            raise ValueError(f"Each button label is 1 to {BUTTON_LABEL_MAX_LENGTH} characters.")
        button: ButtonItem = {"label": label}
        url = item.get("url")
        if url is not None:
            if not isinstance(url, str) or len(url) > BUTTON_URL_MAX_LENGTH or urlsplit(url).scheme not in ("http", "https") or not urlsplit(url).netloc:
                raise ValueError(f"A button url is an http(s) URL of at most {BUTTON_URL_MAX_LENGTH} characters.")
            button["url"] = url
        checked.append(button)
    return {"type": "buttons", "items": checked}


PLACE_TEXT_MAX_LENGTH = 256


def place_part(latitude: float, longitude: float, *, name: Optional[str] = None, address: Optional[str] = None) -> PlacePart:
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError("latitude is -90 to 90 and longitude -180 to 180.")
    part: PlacePart = {"type": "place", "latitude": latitude, "longitude": longitude}
    for key, text in (("name", name), ("address", address)):
        if text is None:
            continue
        text = text.strip()
        if not 1 <= len(text) <= PLACE_TEXT_MAX_LENGTH:
            raise ValueError(f"A place {key} is 1 to {PLACE_TEXT_MAX_LENGTH} characters after trimming.")
        part[key] = text  # type: ignore[literal-required]
    return part


def payment_part(checkout_url: str) -> PaymentPart:
    return {"type": "payment", "checkout_url": checkout_url}


__all__ = [
    "BUTTONS_MAX_ITEMS",
    "BUTTON_LABEL_MAX_LENGTH",
    "BUTTON_URL_MAX_LENGTH",
    "ButtonItem",
    "ButtonsPart",
    "CarouselPart",
    "FormPart",
    "FormResponsePart",
    "LinkPart",
    "PLACE_TEXT_MAX_LENGTH",
    "MediaPart",
    "MessageContent",
    "MessageReplyTo",
    "MessagePart",
    "PaymentPart",
    "PlacePart",
    "ReactionType",
    "RatingRequestPart",
    "RatingRequestPartResponse",
    "RatingRequestRating",
    "rating_request_part",
    "RichCardPart",
    "SelectionPart",
    "SelectionResponsePart",
    "SelectionSectionedPart",
    "SuggestionResponsePart",
    "TextPart",
    "buttons_part",
    "link_part",
    "media_part",
    "payment_part",
    "place_part",
    "text_part",
]
