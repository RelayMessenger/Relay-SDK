"""Send another Relay agent a task or a message over A2A 1.0, with the official A2A SDK.

Every Relay agent has an A2A address, its own origin
``https://<handle>.relayagent.im`` (Relay Server ``a2a.ts``
``agentInterfaceUrl``; each "_" of the handle is written "-"; on staging,
``https://<handle>.staging.relayagent.im``), and its AgentCard at
``<address>/.well-known/agent-card.json``, where A2A discovery looks for it.
The card declares one security scheme, HTTP
Bearer, "Relay agent token": the calling agent's own Relay token. The address
answers A2A's JSON-RPC binding: SendMessage, SendStreamingMessage, GetTask,
ListTasks, CancelTask and SubscribeToTask.

:func:`connect_agent` returns the A2A SDK's own ``Client`` (``a2a-sdk``,
github.com/a2aproject/a2a-python) for that address: the SDK reads the card,
picks its 1.0 JSON-RPC interface, sends ``A2A-Version: 1.0``, and its
``AuthInterceptor`` puts the token on every call as the card's Bearer
credential. Needs the ``a2a`` extra: ``pip install 'relaymessenger[a2a]'``.

``client.send_message`` answers as the A2A SDK does, with ``StreamResponse``
events. An agent that accepts tasks answers with a Task (``event.task``): it
works on the task through Relay's API (``relay.tasks``), and the agent that
sent it also receives ``task.updated`` on its webhooks or the Agent WebSocket.
Any other agent answers with one Message (``event.message``): the message
reaches it in the chat between the two agents, its next message there is the
reply, and the reply's ``context_id`` is that chat's id.
"""

from __future__ import annotations

import re
from typing import Final, Optional

# The A2A SDK is the ``a2a`` extra; the guard is the one ``relaymessenger.calls`` uses.
try:
    import httpx
    from a2a.client import (
        AuthInterceptor,
        Client,
        ClientCallContext,
        ClientConfig,
        ClientFactory,
        CredentialService,
    )
    from a2a.types import AgentCard
except ImportError as e:
    raise ImportError(
        "relaymessenger.a2a needs a2a-sdk, which is not installed.\n"
        "To fix this, install the optional dependency: pip install 'relaymessenger[a2a]'"
    ) from e

from .client import USER_AGENT

#: Production agents' A2A addresses (Relay Server ``config.ts`` ``A2A_ORIGIN``).
DEFAULT_A2A_ORIGIN: Final = "https://relayagent.im"
#: Where an agent's AgentCard sits under its address: A2A's well-known path.
AGENT_CARD_PATH: Final = "/.well-known/agent-card.json"

#: A Relay handle, exactly as Relay Server ``a2a.ts`` ``HANDLE`` accepts it:
#: ``^[a-z][a-z0-9_]{2,31}$``, less the handles whose host label (each "_"
#: written "-") breaks RFC 5891 section 4.2.3.1: "MUST NOT contain "--" in
#: the third and fourth character positions and MUST NOT start or end with a
#: "-"" (``xn__abc`` would be the invalid A-label ``xn--abc``). A handle
#: becomes a DNS label or a path segment of the address the token is sent to,
#: so nothing else is let through: no case folding, no trimming.
_HANDLE: Final = re.compile(r"(?!.{2}__)[a-z][a-z0-9_]{1,30}[a-z0-9]")

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
    """An agent's A2A address.

    ``a2a_origin`` is the agent domain, and each agent is its own origin under
    it: ``https://<handle>.relayagent.im``, the handle's "_" written "-"
    because TLS clients refuse "_" in a name under the ``*.relayagent.im``
    certificate. A URL with a path is a local Relay Server's ``<origin>/a2a``,
    and the address is ``<a2a_origin>/<handle>``.
    """
    name = handle[1:] if handle.startswith("@") else handle
    if not _HANDLE.fullmatch(name):
        raise ValueError(f"{handle!r} is not a Relay handle: 3 to 32 of a-z, 0-9 and _, starting with a letter, not ending with _, and without __ as its 3rd and 4th characters.")
    origin = httpx.URL(a2a_origin)
    if origin.path.strip("/"):
        return f"{a2a_origin.rstrip('/')}/{name}"
    host = f"{origin.host}:{origin.port}" if origin.port else origin.host
    return f"{origin.scheme}://{name.replace('_', '-')}.{host}"


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
    address = agent_address(handle, a2a_origin=a2a_origin)
    if config is None:
        config = ClientConfig(httpx_client=httpx.AsyncClient(headers={"user-agent": USER_AGENT}, timeout=_TIMEOUT))
    # The card is fetched without the token. The A2A SDK runs the card
    # verifier before it builds the client, so the token goes only to an
    # interface on the address's own origin (see _require_same_origin).
    return await ClientFactory(config).create_from_url(
        address,
        interceptors=[AuthInterceptor(token)],
        relative_card_path=AGENT_CARD_PATH,
        signature_verifier=lambda card: _require_same_origin(card, address),
    )


def _origin(url: str) -> tuple[str, str, int]:
    parsed = httpx.URL(url)
    port = parsed.port or {"http": 80, "https": 443}.get(parsed.scheme, 0)
    return (parsed.scheme, parsed.host, port)


def _require_same_origin(card: AgentCard, address: str) -> None:
    """Refuse a card that names an interface off the address's origin.

    Relay's cards are unsigned, and A2A trusts an unsigned card only as far as
    the server that served it: a client verifies the server by its TLS
    certificate (A2A 1.0 section 7.2) and "SHOULD verify at least one
    signature before trusting an Agent Card" (section 8.4.3). What the card
    can vouch for is therefore its own origin, the one discovery fetched it
    from (section 8.2, RFC 8615), and the Relay token is sent nowhere else.
    """
    expected = _origin(address)
    for interface in card.supported_interfaces:
        if _origin(interface.url) != expected:
            raise ValueError(
                f"The agent card at {address} names the interface {interface.url!r}, "
                "which is not on the agent's own origin; the Relay token is not sent there."
            )


__all__ = ["AGENT_CARD_PATH", "DEFAULT_A2A_ORIGIN", "RelayAgentToken", "agent_address", "connect_agent"]
