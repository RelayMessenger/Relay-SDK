"""Relay for Python, the twin of the npm package ``@relaymessenger/sdk``.

``relaymessenger.Relay`` is Relay's REST API and, as ``relay.websocket``, the
Agent WebSocket that delivers the agent's events; ``relaymessenger.selection``
builds and sends selection prompts; ``relaymessenger.rich_cards`` types rich
cards and carousels and reads their replies; ``relaymessenger.parts`` types
every message part; ``relaymessenger.webhooks`` checks webhook signatures. All
use only the standard library.

``relaymessenger.calls`` joins a Relay Call as a WebRTC participant; it needs
the ``calls`` extra (``pip install 'relaymessenger[calls]'``). Importing
``relaymessenger`` alone loads no media dependency.
"""

from . import form, parts, rich_cards, selection, webhooks, websocket
from .client import (
    DEFAULT_BASE_URL,
    AgeRange,
    AgentAgeRating,
    CallContact,
    ChatHandle,
    RiveFile,
    ContactCard,
    ContactEventContact,
    OwnerPerson,
    SystemEventParty,
    UserOwner,
    Relay,
    RelayAPIError,
    ReplyTo,
    SendMessageResponse,
)
from .errors import RelayUnknownEventTypeError, RelayWebhookConfiguredError
from .webhooks import WebhookVerificationError, sign_webhook_headers, verify_webhook_signature
from .websocket import (
    WebSocketEventContext,
    WebSocketFullSyncContext,
    WebSocketProtocolError,
    WebSocketStoppedError,
)

__all__ = [
    "DEFAULT_BASE_URL",
    "AgeRange",
    "AgentAgeRating",
    "CallContact",
    "ChatHandle",
    "RiveFile",
    "ContactCard",
    "ContactEventContact",
    "OwnerPerson",
    "SystemEventParty",
    "UserOwner",
    "Relay",
    "RelayAPIError",
    "RelayUnknownEventTypeError",
    "RelayWebhookConfiguredError",
    "ReplyTo",
    "SendMessageResponse",
    "WebSocketEventContext",
    "WebSocketFullSyncContext",
    "WebSocketProtocolError",
    "WebSocketStoppedError",
    "WebhookVerificationError",
    "form",
    "parts",
    "rich_cards",
    "selection",
    "sign_webhook_headers",
    "verify_webhook_signature",
    "webhooks",
    "websocket",
]
