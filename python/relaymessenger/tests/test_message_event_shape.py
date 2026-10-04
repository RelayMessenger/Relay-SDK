"""Message events in both shapes (Relay-Server ed5608a1, 2026-10-04).

The 2026-08-30 fixture is what servers before ed5608a1 send: only the
deprecated ``chat`` and ``sender_handle``. The 2026-10-04 fixture adds the REST
Message's ``chat_id``, ``from_handle`` and ``is_from_me``. ``MessageEvent``
must type every key of both, and the documented read (new key first, old key
second) must name the same sender and chat for each.
"""

import json
from pathlib import Path
from typing import Any, Dict, Optional, get_type_hints

from relaymessenger import MessageEvent, sign_webhook_headers
from relaymessenger.webhooks import Webhooks

ROOT = Path(__file__).resolve().parents[3]
LEGACY = json.loads((ROOT / "packages/sdk/test/fixtures/message.received.json").read_text())
SHAPES = json.loads((ROOT / "test/fixtures/message-event-shapes-2026-10-04.json").read_text())
SECRET = "whsec_" + "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
TYPED = set(get_type_hints(MessageEvent)) | {"from", "thread"}


def sender(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    return data.get("from_handle") or data.get("sender_handle")


def chat_id(data: Dict[str, Any]) -> Optional[str]:
    return data.get("chat_id") or (data.get("chat") or {}).get("id")


def test_the_2026_08_30_event_still_unwraps_and_types() -> None:
    body = json.dumps(LEGACY)
    event = Webhooks(SECRET).unwrap(
        body, headers=sign_webhook_headers(SECRET, id=LEGACY["event_id"], body=body)
    )
    assert set(event["data"]) <= TYPED
    assert sender(event["data"])["handle"] == "advait"
    assert chat_id(event["data"]) == LEGACY["data"]["chat"]["id"]


def test_every_2026_10_04_shape_names_the_same_sender_and_chat() -> None:
    expected = SHAPES["expected"]
    assert set(SHAPES["events"]) == {"old_keys_only", "new_keys_only", "both"}
    for shape, data in SHAPES["events"].items():
        assert set(data) <= TYPED, shape
        assert sender(data)["id"] == expected["sender_id"], shape
        assert sender(data)["handle"] == expected["sender_handle"], shape
        assert chat_id(data) == expected["chat_id"], shape
    assert "is_from_me" in get_type_hints(MessageEvent)
