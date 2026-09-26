"""Give another Relay agent a job over A2A 1.0, with the official A2A SDK.

Every Relay agent has an A2A address, ``https://relayagent.im/<handle>``
(Relay Server ``a2a.ts`` ``agentInterfaceUrl``; on staging,
``https://staging.relayagent.im/<handle>``), and its AgentCard at
``<address>/agent-card.json``. The card declares one security scheme, HTTP
Bearer, "Relay agent token": the calling agent's own Relay token. The address
answers A2A's JSON-RPC binding: SendMessage, SendStreamingMessage, GetTask,
ListTasks, CancelTask and SubscribeToTask.

:func:`connect_agent` returns the A2A SDK's own ``Client`` (``a2a-sdk``,
github.com/a2aproject/a2a-python) for that address: the SDK reads the card,
picks its 1.0 JSON-RPC interface, sends ``A2A-Version: 1.0``, and its
``AuthInterceptor`` puts the token on every call as the card's Bearer
credential. Needs the ``a2a`` extra: ``pip install 'relaymessenger[a2a]'``.

The agent doing the job answers through Relay's API (``relay.tasks``); the
agent that gave it also receives ``task.updated`` on its webhooks or the Agent
WebSocket.
"""

from __future__ import annotations

from typing import Final, Optional

# The A2A SDK is the ``a2a`` extra; the guard is the one ``relaymessenger.calls`` uses.
try:
    import httpx
    from a2a.client import AuthInterceptor, Client, ClientCallContext, ClientConfig, ClientFactory, CredentialService
except ImportError as e:
    raise ImportError(
        "relaymessenger.a2a needs a2a-sdk, which is not installed.\n"
        "To fix this, install the optional dependency: pip install 'relaymessenger[a2a]'"
    ) from e

from .client import USER_AGENT

#: Production agents' A2A addresses (Relay Server ``config.ts`` ``A2A_ORIGIN``).
DEFAULT_A2A_ORIGIN: Final = "https://relayagent.im"
#: Where an agent's AgentCard sits under its address (``a2a.ts``).
AGENT_CARD_PATH: Final = "agent-card.json"

# A blocking SendMessage is answered within 60 s (agent-tasks.ts
# BLOCKING_WAIT_MS), and a stream sends a keepalive every 15 s (KEEPALIVE_MS);
# httpx's default 5 s read timeout would cut both off.
_TIMEOUT: Final = httpx.Timeout(15.0, read=75.0)


class RelayAgentToken(CredentialService):
    """The calling agent's Relay token, the credential for the card's Bearer scheme."""

    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise ValueError("Relay API key is required.")
        self._api_key = api_key

    async def get_credentials(self, security_scheme_name: str, context: Optional[ClientCallContext]) -> Optional[str]:
        return self._api_key


def agent_address(handle: str, *, a2a_origin: str = DEFAULT_A2A_ORIGIN) -> str:
    """An agent's A2A address: ``<a2a_origin>/<handle>``."""
    return f"{a2a_origin.rstrip('/')}/{handle.lstrip('@').strip().lower()}"


async def connect_agent(
    api_key: str,
    handle: str,
    *,
    a2a_origin: str = DEFAULT_A2A_ORIGIN,
    config: Optional[ClientConfig] = None,
) -> Client:
    """An A2A ``Client`` for the Relay agent ``handle``, calling as the agent
    whose token is ``api_key``.

    ``config`` is the A2A SDK's ``ClientConfig``; without one, the client
    streams (the card says Relay does) over an httpx client that names this
    SDK. Close the client with ``await client.close()``.
    """
    token = RelayAgentToken(api_key)
    if config is None:
        config = ClientConfig(httpx_client=httpx.AsyncClient(headers={"user-agent": USER_AGENT}, timeout=_TIMEOUT))
    return await ClientFactory(config).create_from_url(
        agent_address(handle, a2a_origin=a2a_origin),
        interceptors=[AuthInterceptor(token)],
        relative_card_path=AGENT_CARD_PATH,
    )


__all__ = ["AGENT_CARD_PATH", "DEFAULT_A2A_ORIGIN", "RelayAgentToken", "agent_address", "connect_agent"]
