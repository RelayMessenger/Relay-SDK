"""Rich cards and carousels: the twin of ``@relaymessenger/sdk``'s card types
and ``suggestionReply`` (``RichCardPart``, ``CarouselPart`` and
``SuggestionResponsePart`` in contracts/relay-v1-openapi.yaml).

An agent sends one ``rich_card`` (a picture or video, a title of at most 200
characters, a description of at most 2000, up to 4 suggestions) or a
``carousel`` of 2 to 10 cards. A ``reply`` suggestion comes back as a
``message.received`` whose parts are a text part equal to the reply's label and
a ``suggestion_response`` part carrying its ``id`` and ``label``, with
``reply_to`` naming the card part. Dispatch on ``id``, never on the label.
Every other suggestion is an action the person's phone does itself.
"""

from __future__ import annotations

from typing import Any, List, Literal, Mapping, Optional, Sequence, TypedDict, Union

RICH_CARD_TITLE_MAX_LENGTH = 200
RICH_CARD_DESCRIPTION_MAX_LENGTH = 2000
RICH_CARD_MAX_SUGGESTIONS = 4
SUGGESTION_LABEL_MAX_LENGTH = 25
SUGGESTION_ID_MAX_LENGTH = 256
CAROUSEL_MIN_CARDS = 2
CAROUSEL_MAX_CARDS = 10


class _MediaRequired(TypedDict):
    type: Literal["image", "video"]
    #: A public https URL.
    url: str


class RichCardMedia(_MediaRequired, total=False):
    #: A public https URL of a still shown before a video plays.
    thumbnail_url: str
    #: short is 112 pt, medium (the default) 168 pt, tall 264 pt.
    height: Literal["short", "medium", "tall"]


class ReplySuggestion(TypedDict):
    type: Literal["reply"]
    #: 1 to 25 characters.
    label: str
    #: 1 to 256 characters, unique within the part.
    id: str


class _OpenUrlRequired(TypedDict):
    type: Literal["open_url"]
    label: str
    #: http or https only.
    url: str


class OpenUrlSuggestion(_OpenUrlRequired, total=False):
    application: Literal["browser", "webview"]


class DialSuggestion(TypedDict):
    type: Literal["dial"]
    label: str
    #: E.164, for example +12223334444.
    phone_number: str


class _ViewLocationRequired(TypedDict):
    type: Literal["view_location"]
    label: str


class ViewLocationSuggestion(_ViewLocationRequired, total=False):
    #: Give latitude and longitude together, or a query.
    latitude: float
    longitude: float
    #: The pin's name.
    name: str
    query: str


class ShareLocationSuggestion(TypedDict):
    type: Literal["share_location"]
    label: str


class _CalendarRequired(TypedDict):
    type: Literal["create_calendar_event"]
    label: str
    #: RFC 3339.
    start_time: str
    #: RFC 3339, not before start_time.
    end_time: str
    #: 1 to 100 characters.
    title: str


class CreateCalendarEventSuggestion(_CalendarRequired, total=False):
    #: Up to 500 characters.
    description: str


RichCardSuggestion = Union[
    ReplySuggestion,
    OpenUrlSuggestion,
    DialSuggestion,
    ViewLocationSuggestion,
    ShareLocationSuggestion,
    CreateCalendarEventSuggestion,
]


class CardContent(TypedDict, total=False):
    """One card: at least one of media, title (1 to 200) or description (1 to 2000)."""

    media: RichCardMedia
    title: str
    description: str
    #: 1 to 4.
    suggestions: List[RichCardSuggestion]


class _RichCardRequired(TypedDict):
    type: Literal["rich_card"]


class RichCardPart(_RichCardRequired, CardContent, total=False):
    pass


class _CarouselRequired(TypedDict):
    type: Literal["carousel"]
    #: 2 to 10 cards.
    cards: List[CardContent]


class CarouselPart(_CarouselRequired, total=False):
    #: small is 180 pt; medium (the default) is as wide as a single card, up to 350 pt.
    card_width: Literal["small", "medium"]


class SuggestionResponsePart(TypedDict):
    """What the person sends after the text part equal to the reply's label."""

    type: Literal["suggestion_response"]
    id: str


class SuggestionResponsePartResponse(SuggestionResponsePart):
    """The reply as the agent reads it: its id and the label the card showed."""

    label: str


class SuggestionReply(TypedDict):
    id: str
    label: str
    reply_to: Mapping[str, Any]


def suggestion_reply(
    parts: Sequence[Mapping[str, Any]], reply_to: Optional[Mapping[str, Any]] = None
) -> Optional[SuggestionReply]:
    """The card reply in a received message: its ``id``, its ``label`` and the
    card part it answers, or ``None`` when the message is not a card reply."""
    response = next((part for part in parts if part.get("type") == "suggestion_response"), None)
    if response is None or not reply_to or not reply_to.get("message_id"):
        return None
    index = reply_to.get("part_index")
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        return None
    return {
        "id": str(response.get("id", "")),
        "label": str(response.get("label", "")),
        "reply_to": {"message_id": reply_to["message_id"], "part_index": index},
    }


__all__ = [
    "CAROUSEL_MAX_CARDS",
    "CAROUSEL_MIN_CARDS",
    "CardContent",
    "CarouselPart",
    "CreateCalendarEventSuggestion",
    "DialSuggestion",
    "OpenUrlSuggestion",
    "RICH_CARD_DESCRIPTION_MAX_LENGTH",
    "RICH_CARD_MAX_SUGGESTIONS",
    "RICH_CARD_TITLE_MAX_LENGTH",
    "ReplySuggestion",
    "RichCardMedia",
    "RichCardPart",
    "RichCardSuggestion",
    "SUGGESTION_ID_MAX_LENGTH",
    "SUGGESTION_LABEL_MAX_LENGTH",
    "ShareLocationSuggestion",
    "SuggestionReply",
    "SuggestionResponsePart",
    "SuggestionResponsePartResponse",
    "ViewLocationSuggestion",
    "suggestion_reply",
]
