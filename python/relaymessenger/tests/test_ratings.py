"""Agent-facing rating requests and signed notification payloads; no person rate API."""
import base64
import json
from pathlib import Path
from typing import get_type_hints

import pytest

from relaymessenger import (Relay, RatingEvent, RatingDeletedEvent, RatingCreatedWebhook,
                            RatingUpdatedWebhook, RatingDeletedWebhook)
from relaymessenger.parts import RatingRequestPart, RatingRequestPartResponse, rating_request_part
from relaymessenger.websocket import RELAY_WEBHOOK_EVENT_TYPES
from relaymessenger.webhooks import sign_webhook_headers


def test_request_and_response_types_are_distinct():
    assert rating_request_part() == {"type": "rating_request"}
    assert set(get_type_hints(RatingRequestPart)) == {"type"}
    assert set(get_type_hints(RatingRequestPartResponse)) == {"type", "value", "rating", "reactions"}
    assert set(get_type_hints(RatingEvent)) == {"contact", "stars", "review", "created_at", "updated_at"}
    assert set(get_type_hints(RatingDeletedEvent)) == {"contact"}
    for cls in (RatingCreatedWebhook, RatingUpdatedWebhook, RatingDeletedWebhook):
        assert set(get_type_hints(cls)) == {"api_version", "webhook_version", "event_id", "created_at", "trace_id", "agent_id", "event_type", "data"}


FIXTURE = json.loads((Path(__file__).resolve().parents[3] / "test/fixtures/rating-server.json").read_text())


@pytest.mark.parametrize("body", FIXTURE["webhook_bodies"], ids=["created", "updated", "deleted"])
def test_actual_server_signed_event_bytes(body):
    event = json.loads(body)
    event_type = event["event_type"]
    assert event_type in RELAY_WEBHOOK_EVENT_TYPES
    payload_type = RatingDeletedEvent if event_type == "rating.deleted" else RatingEvent
    assert set(event["data"]) == set(get_type_hints(payload_type))
    secret = "whsec_" + base64.b64encode(bytes([12]) * 32).decode()
    client = Relay(api_key="fixture", webhook_secret=secret)
    headers = sign_webhook_headers(secret, id=event["event_id"], body=body)
    assert client.webhooks.unwrap(body, headers=headers) == event
    with pytest.raises(Exception):
        client.webhooks.unwrap(body + " ", headers=headers)
