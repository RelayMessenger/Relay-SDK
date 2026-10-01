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
from typing import Any, Dict, Optional

#: Relay's OpenID Connect issuer. Staging is ``https://auth.staging.relayapp.im/api/auth``.
RELAY_ISSUER = "https://auth.relayapp.im/api/auth"

_key_clients: Dict[str, Any] = {}


def _jwks_client(issuer: str) -> Any:
    try:
        import jwt  # PyJWT
    except ImportError as error:  # pragma: no cover - the message is the point
        raise ImportError("verify_relay_id_token needs the login extra: pip install 'relaymessenger[login]'") from error
    cached = _key_clients.get(issuer)
    if cached is not None:
        return cached
    with urllib.request.urlopen(f"{issuer}/.well-known/openid-configuration", timeout=10) as response:
        discovery = json.load(response)
    if discovery.get("issuer") != issuer or not discovery.get("jwks_uri"):
        raise ValueError("Relay's OpenID configuration does not match the issuer.")
    client = jwt.PyJWKClient(discovery["jwks_uri"])
    _key_clients[issuer] = client
    return client


def verify_relay_id_token(
    id_token: str,
    *,
    client_id: str,
    issuer: str = RELAY_ISSUER,
    nonce: Optional[str] = None,
    leeway: float = 60,
) -> Dict[str, Any]:
    """Verify a Relay ID token and return its claims: ``sub`` (the person),
    ``name``, ``preferred_username`` (the @handle), ``picture``, and
    ``email`` or ``phone_number`` when the person shared them. Raises when
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
    return claims


__all__ = ["RELAY_ISSUER", "verify_relay_id_token"]
