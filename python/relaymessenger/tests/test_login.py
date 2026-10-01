"""Log in with Relay: the agent's OAuth2 client over Relay's REST routes
(Relay Server oauth2-clients.ts) against a local HTTP server, and
verify_relay_id_token against a local issuer serving discovery and a JWKS."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterator, List, Tuple

import pytest

jwt = pytest.importorskip("jwt")
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402

from relaymessenger import Relay  # noqa: E402
from relaymessenger.login import verify_relay_id_token  # noqa: E402

CLIENT_ID = "019f8e21-6c4a-7b1e-9d52-3f0a8c7e41b9"


class _Handler(BaseHTTPRequestHandler):
    routes: Dict[str, Any] = {}
    seen: List[Tuple[str, str, Any]] = []

    def _answer(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        type(self).seen.append((self.command, self.path, body))
        payload = type(self).routes.get(self.path, {"client": {"client_id": CLIENT_ID, "redirect_uris": [], "scopes": ["openid", "profile"], "created_at": "", "updated_at": ""}})
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PATCH = _answer

    def log_message(self, *args: Any) -> None:
        pass


@pytest.fixture()
def server() -> Iterator[str]:
    _Handler.routes = {}
    _Handler.seen = []
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()


def test_oauth2_client_routes(server: str) -> None:
    relay = Relay("agent-token", base_url=server)

    async def run() -> None:
        await relay.oauth2_client.retrieve()
        await relay.oauth2_client.create()
        await relay.oauth2_client.update(redirect_uris=["https://youlearn.ai/cb"], scopes=["openid", "profile", "email"])
        await relay.oauth2_client.reset_secret()
        with pytest.raises(ValueError):
            await relay.oauth2_client.update()

    asyncio.run(run())
    assert [(method, path) for method, path, _ in _Handler.seen] == [
        ("GET", "/v1/oauth2_client"),
        ("POST", "/v1/oauth2_client"),
        ("PATCH", "/v1/oauth2_client"),
        ("POST", "/v1/oauth2_client/reset_secret"),
    ]
    assert _Handler.seen[2][2] == {"redirect_uris": ["https://youlearn.ai/cb"], "scopes": ["openid", "profile", "email"]}


def test_verify_relay_id_token(server: str) -> None:
    issuer = f"{server}/api/auth"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update({"kid": "k1", "alg": "RS256", "use": "sig"})
    _Handler.routes = {
        "/api/auth/.well-known/openid-configuration": {"issuer": issuer, "jwks_uri": f"{issuer}/jwks"},
        "/api/auth/jwks": {"keys": [jwk]},
    }

    def sign(**patch: Any) -> str:
        now = int(time.time())
        claims = {"iss": issuer, "aud": CLIENT_ID, "sub": "user-1", "iat": now, "exp": now + 600, "preferred_username": "ada", **patch}
        return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "k1"})

    claims = verify_relay_id_token(sign(nonce="n1"), client_id=CLIENT_ID, issuer=issuer, nonce="n1")
    assert claims["sub"] == "user-1" and claims["preferred_username"] == "ada"
    with pytest.raises(jwt.InvalidAudienceError):
        verify_relay_id_token(sign(aud="someone-else"), client_id=CLIENT_ID, issuer=issuer)
    with pytest.raises(jwt.ExpiredSignatureError):
        verify_relay_id_token(sign(exp=int(time.time()) - 3600), client_id=CLIENT_ID, issuer=issuer)
    with pytest.raises(jwt.InvalidIssuerError):
        verify_relay_id_token(sign(iss="https://evil.example"), client_id=CLIENT_ID, issuer=issuer)
    with pytest.raises(ValueError, match="nonce"):
        verify_relay_id_token(sign(nonce="a"), client_id=CLIENT_ID, issuer=issuer, nonce="b")
