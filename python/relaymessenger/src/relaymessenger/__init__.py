"""Relay for Python, the twin of the npm package ``@relaymessenger/sdk``.

``relaymessenger.Relay`` is Relay's REST API; ``relaymessenger.a2ui`` builds
A2UI cards, sends them and reads their taps; ``relaymessenger.tasks`` types the
A2A 1.0 Tasks of jobs between agents and their events. All three use only the
standard library.

``relaymessenger.a2a`` gives another Relay agent a job at its A2A address with
the official A2A SDK; it needs the ``a2a`` extra
(``pip install 'relaymessenger[a2a]'``).

``relaymessenger.calls`` joins a Relay Call as a WebRTC participant; it needs
the ``calls`` extra (``pip install 'relaymessenger[calls]'``). Importing
``relaymessenger`` alone loads no media dependency.
"""

from . import a2ui, tasks
from .client import DEFAULT_BASE_URL, Relay, RelayAPIError, ReplyTo, SendMessageResponse

__all__ = ["DEFAULT_BASE_URL", "Relay", "RelayAPIError", "ReplyTo", "SendMessageResponse", "a2ui", "tasks"]
