from relaymessenger import rich_cards
from relaymessenger.rich_cards import suggestion_reply


def test_suggestion_reply_reads_id_label_and_card_part():
    parts = [
        {"type": "text", "value": "Book", "reactions": None},
        {"type": "suggestion_response", "id": "book_lagoon", "label": "Book"},
    ]
    assert suggestion_reply(parts, {"message_id": "m1", "part_index": 1}) == {
        "id": "book_lagoon",
        "label": "Book",
        "reply_to": {"message_id": "m1", "part_index": 1},
    }


def test_suggestion_reply_is_none_without_a_card_target_or_response():
    parts = [{"type": "suggestion_response", "id": "x", "label": "X"}]
    assert suggestion_reply(parts, {"message_id": "m1"}) is None
    assert suggestion_reply(parts, {"message_id": "m1", "part_index": True}) is None
    assert suggestion_reply([{"type": "text", "value": "Book"}], {"message_id": "m1", "part_index": 1}) is None


def test_limits_match_the_contract():
    assert (rich_cards.RICH_CARD_TITLE_MAX_LENGTH, rich_cards.RICH_CARD_DESCRIPTION_MAX_LENGTH) == (200, 2000)
    assert (rich_cards.CAROUSEL_MIN_CARDS, rich_cards.CAROUSEL_MAX_CARDS) == (2, 10)
    assert (rich_cards.SUGGESTION_LABEL_MAX_LENGTH, rich_cards.SUGGESTION_ID_MAX_LENGTH) == (25, 256)


def test_typed_parts_require_their_type():
    from typing import get_type_hints
    from relaymessenger.rich_cards import (
        CarouselPart, RichCardPart, SuggestionResponsePart, SuggestionResponsePartResponse, RichCardSuggestion,
    )
    assert "type" in RichCardPart.__required_keys__
    assert {"title", "media", "description", "suggestions"} <= RichCardPart.__optional_keys__
    assert {"type", "cards"} <= CarouselPart.__required_keys__
    assert SuggestionResponsePart.__required_keys__ == {"type", "id"}
    assert SuggestionResponsePartResponse.__required_keys__ == {"type", "id", "label"}
    kinds = {get_type_hints(kind)["type"].__args__[0] for kind in RichCardSuggestion.__args__}
    assert kinds == {"reply", "open_url", "dial", "view_location", "share_location", "create_calendar_event"}
