"""The chats routes against a local HTTP server: each method's path, HTTP
method, body and headers, as contracts/relay-v1-openapi.yaml ``createChat``,
``listChats``, ``getChat`` and ``getMessages`` name them, and as
packages/sdk/src/client.ts ``Chats`` sends them."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterator, List, Tuple

import pytest

from relaymessenger import Relay, RelayAPIError

Seen = List[Tuple[str, str, Dict[str, str], Any]]

CHAT = {
    "id": "01a05224-50ba-743c-b078-6458f4186e07",
    "display_name": "Bob",
    "handles": [],
    "is_group": False,
    "created_at": "2026-09-27T00:00:00.000Z",
    "updated_at": "2026-09-27T00:00:00.000Z",
}
FIRST = {"parts": [{"type": "text", "value": "hi"}]}


class _Server:
    def __init__(self) -> None:
        self.seen: Seen = []
        self.replies: List[Tuple[int, Any]] = []

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def start(self) -> None:
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                server.seen.append((self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body))
                status, reply = server.replies.pop(0) if server.replies else (200, {})
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _answer

            def log_message(self, format: str, *args: Any) -> None:
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def server() -> Iterator[_Server]:
    s = _Server()
    s.start()
    yield s
    s.stop()


def _requests(server: _Server) -> List[Tuple[str, str, Any]]:
    return [(method, path, body) for method, path, _headers, body in server.seen]


async def test_create_posts_v1_chats_with_the_idempotency_key_header_and_retries(server: _Server) -> None:
    created = {"chat": {**{k: CHAT[k] for k in ("id", "display_name", "is_group", "handles")}, "message": {"id": "m1"}}}
    server.replies += [(503, {"error": {"message": "busy"}}), (201, created)]
    relay = Relay("tok", base_url=server.base_url, retry_base_delay=0)
    body = {"from": "me_bot", "to": ["bob_bot"], "message": {**FIRST, "idempotency_key": "first-1"}}
    assert await relay.chats.create(body) == created
    assert _requests(server) == [("POST", "/v1/chats", body)] * 2
    headers = server.seen[0][2]
    assert headers["idempotency-key"] == "first-1"
    assert headers["authorization"] == "Bearer tok"
    assert headers["content-type"] == "application/json"


async def test_create_without_a_key_sends_no_header_and_is_not_retried(server: _Server) -> None:
    server.replies += [(503, {"error": {"message": "busy"}}), (201, {})]
    relay = Relay("tok", base_url=server.base_url, retry_base_delay=0)
    body = {"from": "me_bot", "to": ["bob_bot", "cleo_bot"], "message": FIRST}
    with pytest.raises(RelayAPIError) as raised:
        await relay.chats.create(body)
    assert raised.value.status == 503
    assert _requests(server) == [("POST", "/v1/chats", body)]
    assert "idempotency-key" not in server.seen[0][2]


async def test_retrieve_gets_one_chat(server: _Server) -> None:
    server.replies.append((200, CHAT))
    relay = Relay("tok", base_url=server.base_url)
    assert await relay.chats.retrieve("a/b") == CHAT
    assert _requests(server) == [("GET", "/v1/chats/a%2Fb", None)]


async def test_list_chats_sends_only_the_query_it_is_given(server: _Server) -> None:
    server.replies += [(200, {"chats": [CHAT], "next_cursor": "c2"}), (200, {"chats": [], "next_cursor": None})]
    relay = Relay("tok", base_url=server.base_url)
    assert await relay.chats.list_chats(limit=1) == {"chats": [CHAT], "next_cursor": "c2"}
    await relay.chats.list_chats(cursor="c2", limit=1)
    await relay.chats.list_chats()
    assert _requests(server) == [
        ("GET", "/v1/chats?limit=1", None),
        ("GET", "/v1/chats?cursor=c2&limit=1", None),
        ("GET", "/v1/chats", None),
    ]


async def test_messages_list_gets_the_chats_messages_with_cursor_limit_and_order(server: _Server) -> None:
    page = {"messages": [{"id": "m1"}], "next_cursor": "m-next"}
    server.replies += [(200, page), (200, {"messages": []})]
    relay = Relay("tok", base_url=server.base_url)
    assert await relay.chats.messages.list(CHAT["id"], order="desc", limit=10) == page
    await relay.chats.messages.list(CHAT["id"], cursor="m-next", order="desc")
    assert _requests(server) == [
        ("GET", f"/v1/chats/{CHAT['id']}/messages?limit=10&order=desc", None),
        ("GET", f"/v1/chats/{CHAT['id']}/messages?cursor=m-next&order=desc", None),
    ]
