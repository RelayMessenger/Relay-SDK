"""Log in with Relay: check a Relay ID token.

Relay is a standard OpenID Connect provider, so any OpenID Connect library
works (Authlib, python-social-auth, oidc-client). This is the one step a
website that already holds an ID token needs: its signature against Relay's
published keys, its issuer, its audience (your client ID, which is your
agent's ID) and its expiry, checked by PyJWT (OpenID Connect Core 3.1.3.7).

Needs the ``login`` extra: ``pip install 'relaymessenger[login]'``.
"""

from __future__ import annotations

import json
import urllib.request
from typing import Any, Dict, Final, Optional, TypedDict, cast
from urllib.parse import urlsplit

from .client import USER_AGENT

#: Relay's OpenID Connect issuer. Staging is ``https://auth.staging.relayapp.im/api/auth``.
RELAY_ISSUER = "https://auth.relayapp.im/api/auth"

#: The claim that carries the person's ``id`` as your agent sees it in chats
#: (``sender_handle.id`` on ``message.received``), with the ``openid`` and
#: ``profile`` scopes, when the person has a Relay profile. ``sub`` is a
#: different ID and never appears in chats.
RELAY_USER_ID_CLAIM: Final = "https://relayapp.im/user_id"

_RelayIdTokenClaimsRequired = TypedDict(
    "_RelayIdTokenClaimsRequired",
    {"sub": str, "aud": str, "iss": str, "exp": int, "iat": int},
)


# The functional form, because one claim's name is a URL.
_RelayIdTokenClaimsOptional = TypedDict(
    "_RelayIdTokenClaimsOptional",
    {
        "nonce": str,
        "name": str,
        # The person's Relay @handle, without the @.
        "preferred_username": str,
        "picture": str,
        "email": str,
        "email_verified": bool,
        # E.164, only with the phone scope and when the person shared it.
        "phone_number": str,
        "phone_number_verified": bool,
        # RELAY_USER_ID_CLAIM: the person's id as your agent sees it in chats.
        "https://relayapp.im/user_id": str,
    },
    total=False,
)


class RelayIdTokenClaims(_RelayIdTokenClaimsRequired, _RelayIdTokenClaimsOptional):
    """The claims Relay puts in an ID token. ``email`` and ``phone_number``
    only when the person shared them; ``claims[RELAY_USER_ID_CLAIM]`` (the
    person's ``id`` in chats) when the person has a Relay profile."""

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_key_clients: Dict[str, Any] = {}


def _assert_safe_oidc_url(url: str, label: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme == "https" and parsed.hostname:
        return url
    if parsed.scheme == "http" and parsed.hostname in _LOOPBACK_HOSTS:
        return url
    raise ValueError(f"{label} must use HTTPS (http is allowed only for loopback).")


def _jwks_client(issuer: str) -> Any:
    try:
        import jwt  # PyJWT
    except ImportError as error:  # pragma: no cover - the message is the point
        raise ImportError("verify_relay_id_token needs the login extra: pip install 'relaymessenger[login]'") from error
    _assert_safe_oidc_url(issuer, "Relay OpenID issuer")
    cached = _key_clients.get(issuer)
    if cached is not None:
        return cached
    request = urllib.request.Request(
        f"{issuer}/.well-known/openid-configuration",
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        discovery = json.load(response)
    jwks_uri = discovery.get("jwks_uri")
    if discovery.get("issuer") != issuer or not isinstance(jwks_uri, str) or not jwks_uri:
        raise ValueError("Relay's OpenID configuration does not match the issuer.")
    _assert_safe_oidc_url(jwks_uri, "Relay OpenID jwks_uri")
    client = jwt.PyJWKClient(jwks_uri, timeout=10, headers={"User-Agent": USER_AGENT})
    _key_clients[issuer] = client
    return client


def verify_relay_id_token(
    id_token: str,
    *,
    client_id: str,
    issuer: str = RELAY_ISSUER,
    nonce: Optional[str] = None,
    leeway: float = 60,
) -> RelayIdTokenClaims:
    """Verify a Relay ID token and return its claims: ``sub`` (the person),
    ``name``, ``preferred_username`` (the @handle), ``picture``,
    ``email`` or ``phone_number`` when the person shared them, and
    ``RELAY_USER_ID_CLAIM``, the person's ``id`` as your agent sees it in chats. Raises when
    the signature, issuer, audience, expiry or nonce is wrong."""
    import jwt

    issuer = issuer.rstrip("/")
    key = _jwks_client(issuer).get_signing_key_from_jwt(id_token)
    claims: Dict[str, Any] = jwt.decode(
        id_token,
        key.key,
        algorithms=["RS256"],
        audience=client_id,
        issuer=issuer,
        leeway=leeway,
        options={"require": ["sub", "exp", "iat", "iss", "aud"]},
    )
    if nonce is not None and claims.get("nonce") != nonce:
        raise ValueError("The ID token's nonce does not match the login request.")
    return cast(RelayIdTokenClaims, claims)


__all__ = ["RELAY_ISSUER", "RELAY_USER_ID_CLAIM", "RelayIdTokenClaims", "verify_relay_id_token"]
