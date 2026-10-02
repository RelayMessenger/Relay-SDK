"""Agent-facing rating requests and signed notification payloads; no person rate API."""
import base64
import json
from typing import get_type_hints

import pytest

from relaymessenger import (Relay, RatingEvent, RatingDeletedEvent, RatingCreatedWebhook,
                            RatingUpdatedWebhook, RatingDeletedWebhook)
from relaymessenger.parts import RatingRequestPart, RatingRequestPartResponse, rating_request_part
from relaymessenger.websocket import RELAY_WEBHOOK_EVENT_TYPES, websocket_url
from relaymessenger.webhooks import sign_webhook_headers


def test_request_and_response_types_are_distinct():
    assert rating_request_part() == {"type": "rating_request"}
    assert set(get_type_hints(RatingRequestPart)) == {"type"}
    assert set(get_type_hints(RatingRequestPartResponse)) == {"type", "rating", "reactions"}
    assert set(get_type_hints(RatingEvent)) == {"contact", "stars", "review", "created_at", "updated_at"}
    assert set(get_type_hints(RatingDeletedEvent)) == {"contact"}
    for cls in (RatingCreatedWebhook, RatingUpdatedWebhook, RatingDeletedWebhook):
        assert set(get_type_hints(cls)) == {"api_version", "webhook_version", "event_id", "created_at", "trace_id", "agent_id", "event_type", "data"}


@pytest.mark.parametrize("event_type", ["rating.created", "rating.updated", "rating.deleted"])
def test_signed_events_and_websocket_subscription(event_type):
    assert event_type in RELAY_WEBHOOK_EVENT_TYPES
    contact = {"id": "01993d50-b4ce-71e6-8e65-35d325d95ddb", "handle": "person", "display_name": "Person",
               "timezone": None, "age_range": None, "links": [], "about": None}
    data = {"contact": contact}
    if event_type != "rating.deleted":
        data.update(stars=5, review=None, created_at="2026-10-02T00:00:00Z", updated_at="2026-10-02T00:00:00Z")
    event = {"api_version": "v1", "webhook_version": "2026-08-30", "event_type": event_type,
             "event_id": contact["id"], "created_at": "2026-10-02T00:00:00Z", "trace_id": "fixture", "agent_id": contact["id"], "data": data}
    body = json.dumps(event)
    secret = "whsec_" + base64.b64encode(bytes([12]) * 32).decode()
    client = Relay(api_key="fixture", webhook_secret=secret)
    headers = sign_webhook_headers(secret, id=event["event_id"], body=body)
    assert client.webhooks.unwrap(body, headers=headers) == event
    with pytest.raises(Exception):
        client.webhooks.unwrap(body + " ", headers=headers)
