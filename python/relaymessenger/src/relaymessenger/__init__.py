"""Relay for Python, the twin of the npm package ``@relaymessenger/sdk``.

``relaymessenger.Relay`` is Relay's REST API; ``relaymessenger.a2ui`` builds
A2UI cards, sends them and reads their taps. Both use only the standard
library.

``relaymessenger.calls`` joins a Relay Call as a WebRTC participant; it needs
the ``calls`` extra (``pip install 'relaymessenger[calls]'``). Importing
``relaymessenger`` alone loads no media dependency.
"""

from . import a2ui
from .client import DEFAULT_BASE_URL, Relay, RelayAPIError, ReplyTo, SendMessageResponse

__all__ = ["DEFAULT_BASE_URL", "Relay", "RelayAPIError", "ReplyTo", "SendMessageResponse", "a2ui"]
