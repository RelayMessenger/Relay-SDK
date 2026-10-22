"""A2UI v1.0 cards (Relay-Server 5a860e17): an agent sends a data part,
receives a tap as a data part, and reads the renderer's catalogs from
``metadata.a2uiRendererCapabilities`` on ``message.received``."""

import json
from pathlib import Path
from typing import get_args, get_type_hints

from relaymessenger import MessageEvent, sign_webhook_headers
from relaymessenger.parts import (
    A2uiActionMessage,
    A2uiRendererCapabilities,
    DataPart,
    DataPartResponse,
    MessageContent,
    MessageEventMetadata,
    MessagePart,
)
from relaymessenger.webhooks import Webhooks

ROOT = Path(__file__).resolve().parents[3]
CONTRACT = (ROOT / "contracts/relay-v1-openapi.yaml").read_text()
SECRET = "whsec_" + "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
RELAY = "https://relayapp.im/a2ui/catalogs/relay/v1/catalog.json"
BASIC = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"


def test_data_part_is_a_sendable_part_with_the_contract_keys() -> None:
    assert DataPart in get_args(MessagePart)
    hints = get_type_hints(DataPart)
    assert set(hints) == {"type", "media_type", "data"}
    assert get_args(hints["type"]) == ("data",)
    assert get_args(hints["media_type"]) == ("application/a2ui+json",)
    assert set(get_type_hints(DataPartResponse)) == {"type", "media_type", "data", "reactions"}
    assert "    DataPart:\n" in CONTRACT and "enum: [application/a2ui+json]" in CONTRACT


def test_a_card_round_trips_through_a_send_body() -> None:
    card: DataPart = {
        "type": "data",
        "media_type": "application/a2ui+json",
        "data": [
            {"version": "v1.0", "createSurface": {"surfaceId": "order-1", "catalogId": BASIC}},
            {"version": "v1.0", "updateComponents": {"surfaceId": "order-1", "components": [
                {"id": "root", "component": "Text", "text": "Confirm"},
            ]}},
        ],
    }
    content: MessageContent = {"parts": [{"type": "text", "value": "Your order"}, card]}
    assert json.loads(json.dumps(content)) == content


def test_a_received_tap_and_the_renderer_capabilities_are_typed_and_readable() -> None:
    tap: A2uiActionMessage = {"version": "v1.0", "action": {
        "name": "confirm", "surfaceId": "order-1", "sourceComponentId": "root",
        "timestamp": "2026-10-22T12:00:00Z", "context": {"qty": 2},
    }}
    capabilities: A2uiRendererCapabilities = {"v1.0": {"supportedCatalogIds": [RELAY, BASIC]}}
    envelope = {
        "api_version": "v1", "webhook_version": "2026-08-30", "event_type": "message.received",
        "event_id": "evt_a2ui_1", "created_at": "2026-10-22T12:00:00Z",
        "data": {
            "id": "9b1d2c3e-4f5a-4b6c-8d7e-1f2a3b4c5d6e", "direction": "inbound",
            "chat": {"id": "6f6a2e1c-0c3b-4c4e-9a8e-0f1e2d3c4b5a"}, "is_from_me": False,
            "parts": [{"type": "data", "media_type": "application/a2ui+json", "data": [tap], "reactions": None}],
            "metadata": {"a2uiRendererCapabilities": capabilities},
        },
    }
    body = json.dumps(envelope)
    event = Webhooks(SECRET).unwrap(body, headers=sign_webhook_headers(SECRET, id="evt_a2ui_1", body=body))
    data: MessageEvent = event["data"]
    assert set(data) <= set(get_type_hints(MessageEvent))
    assert get_type_hints(MessageEvent)["metadata"] is MessageEventMetadata
    assert get_type_hints(MessageEventMetadata)["a2uiRendererCapabilities"] is A2uiRendererCapabilities
    part = data["parts"][0]
    assert part["type"] == "data" and part["media_type"] == "application/a2ui+json"
    action = part["data"][0]["action"]
    assert (action["name"], action["surfaceId"], action["context"]) == ("confirm", "order-1", {"qty": 2})
    assert data["metadata"]["a2uiRendererCapabilities"]["v1.0"]["supportedCatalogIds"] == [RELAY, BASIC]
