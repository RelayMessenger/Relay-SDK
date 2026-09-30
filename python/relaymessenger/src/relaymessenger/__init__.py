"""Relay for Python, the twin of the npm package ``@relaymessenger/sdk``.

``relaymessenger.Relay`` is Relay's REST API and, as ``relay.websocket``, the
Agent WebSocket that delivers the agent's events; ``relaymessenger.a2ui`` builds
A2UI cards, sends them and reads their taps; ``relaymessenger.selection`` builds
and sends selection prompts; ``relaymessenger.rich_cards`` types rich cards and
carousels and reads their replies. All four use only the standard library.

``relaymessenger.calls`` joins a Relay Call as a WebRTC participant; it needs
the ``calls`` extra (``pip install 'relaymessenger[calls]'``). Importing
``relaymessenger`` alone loads no media dependency.
"""

from . import a2ui, rich_cards, selection, websocket
from .client import DEFAULT_BASE_URL, Relay, RelayAPIError, ReplyTo, SendMessageResponse
from .errors import RelayUnknownEventTypeError, RelayWebhookConfiguredError
from .websocket import (
    WebSocketEventContext,
    WebSocketFullSyncContext,
    WebSocketProtocolError,
    WebSocketStoppedError,
)

__all__ = [
    "DEFAULT_BASE_URL",
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
    "a2ui",
    "rich_cards",
    "selection",
    "websocket",
]
