"""Verify Relay webhook deliveries: the twin of ``verifyWebhookSignature``,
``signWebhookHeaders`` and ``relay.webhooks`` in ``@relaymessenger/sdk``.

Relay signs each delivery the Standard Webhooks way
(https://www.standardwebhooks.com), as the TypeScript SDK's ``standardwebhooks``
dependency checks it: three headers, ``webhook-id``, ``webhook-timestamp``
(unix seconds) and ``webhook-signature`` (space-separated ``v1,<base64
HMAC-SHA256 of "id.timestamp.body">``), keyed by the base64 after the
``whsec_`` prefix of the subscription's ``signing_secret``. A timestamp more
than five minutes from now, either way, is refused. Standard library only.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from typing import Any, Dict, Mapping, Optional, Union

#: Standard Webhooks' replay window, in seconds, both ways.
WEBHOOK_TOLERANCE_SECONDS = 5 * 60
_PREFIX = "whsec_"


class WebhookVerificationError(Exception):
    """The delivery's headers or signature do not check out."""


def _key(secret: str) -> bytes:
    raw = secret[len(_PREFIX):] if secret.startswith(_PREFIX) else secret
    try:
        key = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as error:
        raise WebhookVerificationError("The webhook secret is not base64.") from error
    if not key:
        raise WebhookVerificationError("Secret can't be empty.")
    return key


def _bytes(body: Union[str, bytes]) -> bytes:
    return body.encode("utf-8") if isinstance(body, str) else bytes(body)


def _sign(key: bytes, message_id: str, timestamp: int, body: bytes) -> str:
    digest = hmac.new(key, f"{message_id}.{timestamp}.".encode() + body, hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode()


def _header(headers: Mapping[str, Optional[str]], name: str) -> Optional[str]:
    value = headers.get(name)
    if value is None:
        lowered = {key.lower(): item for key, item in headers.items()}
        value = lowered.get(name)
    return value


def sign_webhook_headers(
    secret: str,
    *,
    id: str,
    body: Union[str, bytes],
    timestamp: Optional[float] = None,
) -> Dict[str, str]:
    """The three Standard Webhooks headers for one delivery, signed with a
    ``whsec_`` secret, as Relay and the CLI's local ``listen`` sign them."""
    seconds = int(time.time() if timestamp is None else timestamp)
    return {
        "webhook-id": id,
        "webhook-timestamp": str(seconds),
        "webhook-signature": _sign(_key(secret), id, seconds, _bytes(body)),
    }


def verify_webhook_signature(
    secret: str,
    body: Union[str, bytes],
    headers: Mapping[str, Optional[str]],
    *,
    now: Optional[float] = None,
) -> None:
    """Raise ``WebhookVerificationError`` unless ``body`` and ``headers`` are a
    delivery signed with ``secret`` within the last five minutes. Pass the raw
    request body, byte for byte, never a re-serialized one."""
    message_id = _header(headers, "webhook-id")
    stamp = _header(headers, "webhook-timestamp")
    signatures = _header(headers, "webhook-signature")
    if not message_id or not stamp or not signatures:
        raise WebhookVerificationError("Missing webhook-id, webhook-timestamp, or webhook-signature.")
    try:
        timestamp = int(stamp)
    except ValueError as error:
        raise WebhookVerificationError("Invalid signature headers.") from error
    current = time.time() if now is None else now
    if timestamp < current - WEBHOOK_TOLERANCE_SECONDS:
        raise WebhookVerificationError("Message timestamp too old.")
    if timestamp > current + WEBHOOK_TOLERANCE_SECONDS:
        raise WebhookVerificationError("Message timestamp too new.")
    expected = _sign(_key(secret), message_id, timestamp, _bytes(body)).split(",", 1)[1]
    for candidate in signatures.split(" "):
        version, _, signature = candidate.partition(",")
        if version == "v1" and hmac.compare_digest(signature.encode(), expected.encode()):
            return
    raise WebhookVerificationError("No matching signature found.")


class Webhooks:
    """``relay.webhooks``: verify with the client's ``webhook_secret``, or a
    ``key`` passed per call."""

    def __init__(self, secret: Optional[str] = None) -> None:
        self._secret = secret

    def verify(self, body: Union[str, bytes], *, headers: Mapping[str, Optional[str]], key: Optional[str] = None) -> None:
        secret = key if key is not None else self._secret
        if not secret:
            raise ValueError("Webhook key is required.")
        verify_webhook_signature(secret, body, headers)

    def unwrap(self, body: Union[str, bytes], *, headers: Mapping[str, Optional[str]], key: Optional[str] = None) -> Any:
        """Verify, then return the delivery's parsed JSON event."""
        self.verify(body, headers=headers, key=key)
        return json.loads(body)


__all__ = [
    "WEBHOOK_TOLERANCE_SECONDS",
    "WebhookVerificationError",
    "Webhooks",
    "sign_webhook_headers",
    "verify_webhook_signature",
]
