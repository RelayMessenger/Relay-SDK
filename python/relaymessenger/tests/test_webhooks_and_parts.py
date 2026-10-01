"""Webhook signatures checked the Standard Webhooks way, against a delivery
the TypeScript SDK's ``standardwebhooks`` signed, and the part builders
against the contract's limits."""

from __future__ import annotations

import json
from typing import Any, Dict

import pytest

from relaymessenger import Relay, WebhookVerificationError, sign_webhook_headers, verify_webhook_signature
from relaymessenger.parts import buttons_part, media_part, place_part, text_part

# Signed by `new Webhook(SECRET).sign("msg_2Kxh", new Date(1790000000 * 1000), BODY)`
# with the npm `standardwebhooks` that packages/sdk/src/webhooks.ts uses.
SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
BODY = '{"type":"message.received","data":{"chat_id":"c1"}}'
STAMP = 1790000000
HEADERS: Dict[str, Any] = {
    "webhook-id": "msg_2Kxh",
    "webhook-timestamp": str(STAMP),
    "webhook-signature": "v1,pz/QHZuTMf2QOBX8gnlGSkyy4aCANPFy7v2CqHsGajg=",
}


def test_a_typescript_signed_delivery_verifies() -> None:
    verify_webhook_signature(SECRET, BODY, HEADERS, now=STAMP + 10)
    verify_webhook_signature(SECRET, BODY.encode(), {k.title(): v for k, v in HEADERS.items()}, now=STAMP)


def test_python_signs_what_typescript_signs() -> None:
    assert sign_webhook_headers(SECRET, id="msg_2Kxh", body=BODY, timestamp=STAMP) == HEADERS


def test_any_matching_signature_among_several_passes() -> None:
    headers = dict(HEADERS, **{"webhook-signature": "v1,AAAA " + HEADERS["webhook-signature"]})
    verify_webhook_signature(SECRET, BODY, headers, now=STAMP)


@pytest.mark.parametrize(
    "body, headers, now, reason",
    [
        (BODY + " ", HEADERS, STAMP, "No matching signature"),
        (BODY, dict(HEADERS, **{"webhook-id": "msg_other"}), STAMP, "No matching signature"),
        (BODY, HEADERS, STAMP + 301, "too old"),
        (BODY, HEADERS, STAMP - 301, "too new"),
        (BODY, {"webhook-id": "msg_2Kxh"}, STAMP, "Missing"),
        (BODY, dict(HEADERS, **{"webhook-signature": "v2," + HEADERS["webhook-signature"][3:]}), STAMP, "No matching"),
    ],
)
def test_a_wrong_delivery_is_refused(body: str, headers: Dict[str, Any], now: int, reason: str) -> None:
    with pytest.raises(WebhookVerificationError, match=reason):
        verify_webhook_signature(SECRET, body, headers, now=now)


def test_relay_webhooks_unwrap_verifies_then_parses() -> None:
    fresh = sign_webhook_headers(SECRET, id="msg_1", body=BODY)
    relay = Relay("rel_test", webhook_secret=SECRET)
    assert relay.webhooks.unwrap(BODY, headers=fresh) == json.loads(BODY)
    with pytest.raises(WebhookVerificationError):
        relay.webhooks.unwrap(BODY, headers=fresh, key="whsec_" + "QUJD")
    with pytest.raises(ValueError, match="Webhook key is required"):
        Relay("rel_test").webhooks.verify(BODY, headers=fresh)


def test_text_part_carries_a_utf16_mention_range() -> None:
    assert text_part("hi 👋 @bob", mention="bob", mention_range=(6, 10)) == {
        "type": "text", "value": "hi 👋 @bob", "mention": "bob", "mention_range": (6, 10),
    }
    with pytest.raises(ValueError):
        text_part("hi 👋 @bob", mention="bob", mention_range=(6, 11))
    with pytest.raises(ValueError):
        text_part("hi", mention_range=(0, 1))


def test_media_part_takes_exactly_one_source() -> None:
    assert media_part(attachment_id="att") == {"type": "media", "attachment_id": "att"}
    with pytest.raises(ValueError):
        media_part()
    with pytest.raises(ValueError):
        media_part(url="https://x.test/a.png", attachment_id="att")


def test_buttons_part_keeps_the_typescript_limits() -> None:
    assert buttons_part([{"label": "Docs", "url": "http://x.test"}, {"label": "Yes"}]) == {
        "type": "buttons", "items": [{"label": "Docs", "url": "http://x.test"}, {"label": "Yes"}],
    }
    for items in ([], [{"label": str(i)} for i in range(6)], [{"label": "x" * 81}], [{"label": "a", "url": "ftp://x"}]):
        with pytest.raises(ValueError):
            buttons_part(items)  # type: ignore[arg-type]


def test_place_part_trims_and_bounds() -> None:
    assert place_part(42.28, -83.74, name="  Diag ") == {"type": "place", "latitude": 42.28, "longitude": -83.74, "name": "Diag"}
    with pytest.raises(ValueError):
        place_part(91, 0)
    with pytest.raises(ValueError):
        place_part(0, 0, address="   ")
