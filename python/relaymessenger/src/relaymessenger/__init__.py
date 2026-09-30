"""Relay for Python, the twin of the npm package ``@relaymessenger/sdk``.

``relaymessenger.Relay`` is Relay's REST API and, as ``relay.websocket``, the
Agent WebSocket that delivers the agent's events; ``relaymessenger.a2ui`` builds
A2UI cards, sends them and reads their taps; ``relaymessenger.selection`` builds
and sends selection prompts; ``relaymessenger.rich_cards`` types rich cards and
carousels and reads their replies; ``relaymessenger.tasks`` types the A2A 1.0 Tasks
between agents and their events. All five use only the standard library.

``relaymessenger.a2a`` sends another Relay agent a task or a message at its A2A
address with the official A2A SDK; it needs the ``a2a`` extra
(``pip install 'relaymessenger[a2a]'``).

``relaymessenger.calls`` joins a Relay Call as a WebRTC participant; it needs
the ``calls`` extra (``pip install 'relaymessenger[calls]'``). Importing
``relaymessenger`` alone loads no media dependency.
"""

from . import a2ui, rich_cards, selection, tasks, websocket
from .client import (
    DEFAULT_BASE_URL,
    AgeRange,
    AgentAgeRating,
    CallContact,
    ChatHandle,
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
    "a2ui",
    "rich_cards",
    "selection",
    "tasks",
    "websocket",
]
