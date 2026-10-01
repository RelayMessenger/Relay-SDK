"""Contact card write responses carry the contract's optional, nullable Rive file."""

from typing import Optional, get_type_hints

from relaymessenger.client import ContactCards, RiveFile, SetContactCardResponse


def test_contact_card_write_response_rive_is_optional_and_nullable() -> None:
    assert "rive" in SetContactCardResponse.__optional_keys__
    assert "rive" not in SetContactCardResponse.__required_keys__
    assert get_type_hints(SetContactCardResponse)["rive"] == Optional[RiveFile]


def test_rive_file_requires_every_key_but_allows_null_names() -> None:
    fields = {
        "file": str,
        "artboard": Optional[str],
        "state_machine": Optional[str],
        "view_model": Optional[str],
    }
    assert get_type_hints(RiveFile) == fields
    assert RiveFile.__required_keys__ == set(fields)
    assert RiveFile.__optional_keys__ == set()


def test_contact_card_create_and_update_return_the_rive_response_type() -> None:
    assert get_type_hints(ContactCards.create)["return"] is SetContactCardResponse
    assert get_type_hints(ContactCards.update)["return"] is SetContactCardResponse
