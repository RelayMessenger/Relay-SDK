"""Python directory types match the carried public schema and keyword API."""

from inspect import Parameter, signature
from typing import List, Literal, Optional, get_args, get_type_hints

from relaymessenger.client import (
    AgentCategory,
    AgentMetrics,
    AgentRatingAverage,
    Chats,
    Directory,
    DirectoryAgent,
    DirectoryProvider,
    DirectorySearchResponse,
)


def test_directory_filter_annotations_and_defaults() -> None:
    assert get_args(AgentCategory) == (
        "productivity", "business", "finance", "shopping", "travel", "health-fitness",
        "lifestyle", "social", "education", "entertainment", "utilities", "developer-tools",
    )
    assert get_type_hints(Directory.search) == {
        "q": Optional[str],
        "category": Optional[AgentCategory],
        "limit": Optional[int],
        "sort": Optional[Literal["name", "newest"]],
        "return": DirectorySearchResponse,
    }
    for name in ("q", "category", "limit", "sort"):
        parameter = signature(Directory.search).parameters[name]
        assert parameter.kind == Parameter.KEYWORD_ONLY
        assert parameter.default is None


def test_directory_response_required_keys_and_nullable_fields() -> None:
    shapes = {
        DirectorySearchResponse: {"agents": List[DirectoryAgent]},
        DirectoryAgent: {
            "handle": str, "name": str, "subtitle": Optional[str], "category": AgentCategory,
            "image_url": Optional[str], "image_color": Optional[str], "accent_color": Optional[str],
            "verified": bool, "provider": DirectoryProvider, "metrics": AgentMetrics,
            "rating": AgentRatingAverage,
        },
        DirectoryProvider: {"name": Optional[str], "url": Optional[str], "verified": bool},
        AgentMetrics: {
            "chats_people": int, "chats_agents": int, "chats_people_30d": int,
            "chats_agents_30d": int, "reply_rate_30d": Optional[float],
            "reply_minutes_30d": Optional[float], "messages_total": int, "since": str,
        },
        AgentRatingAverage: {"average": Optional[float], "count": int},
    }
    for typed, fields in shapes.items():
        assert typed.__required_keys__ == set(fields)
        assert typed.__optional_keys__ == set()
        assert get_type_hints(typed) == fields


def test_share_contact_card_annotations_and_bodyless_default() -> None:
    assert get_type_hints(Chats.share_contact_card) == {
        "chat_id": str, "handle": Optional[str], "user_id": Optional[str],
        "idempotency_key": Optional[str], "return": type(None),
    }
    for name in ("handle", "user_id", "idempotency_key"):
        parameter = signature(Chats.share_contact_card).parameters[name]
        assert parameter.kind == Parameter.KEYWORD_ONLY
        assert parameter.default is None
