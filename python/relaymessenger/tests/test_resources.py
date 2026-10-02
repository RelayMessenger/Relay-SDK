"""Every REST operation the TypeScript client has, against a local HTTP server: each method's HTTP method, path, query and body, as
contracts/relay-v1-openapi.yaml names them and packages/sdk/src/client.ts
sends them."""

from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Iterator, List, Tuple

import pytest

from relaymessenger import Relay, RelayAPIError

CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "relay-v1-openapi.yaml"

Seen = List[Tuple[str, str, Dict[str, str], Any]]


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
                raw = self.rfile.read(length) if length else b""
                try:
                    body: Any = json.loads(raw) if raw else None
                except ValueError:
                    body = raw
                server.seen.append((self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body))
                status, reply = server.replies.pop(0) if server.replies else (200, {})
                if status == 204:
                    self.send_response(204)
                    self.end_headers()
                    return
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _answer

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


def _relay(server: _Server, **options: Any) -> Relay:
    return Relay("rel_test", base_url=server.base_url, retry_base_delay=0, **options)


Call = Callable[[Relay], Awaitable[Any]]

# (operationId, the call, HTTP method, path with query, body)
CASES: List[Tuple[str, Call, str, str, Any]] = [
    ("deleteAgent", lambda r: r.agents.delete("my_bot"), "DELETE", "/v1/agents/my_bot", None),
    ("getMe", lambda r: r.me.retrieve(), "GET", "/v1/me", None),
    ("updateChat", lambda r: r.chats.update("c1", display_name="Team", group_chat_icon=None), "PUT", "/v1/chats/c1",
     {"display_name": "Team", "group_chat_icon": None}),
    ("addParticipant", lambda r: r.chats.participants.add("c1", handle="bob", hide_history=True), "POST",
     "/v1/chats/c1/participants", {"handle": "bob", "hide_history": True}),
    ("removeParticipant", lambda r: r.chats.participants.remove("c1", handle="bob"), "DELETE",
     "/v1/chats/c1/participants", {"handle": "bob"}),
    ("leaveChat", lambda r: r.chats.leave_chat("c1"), "POST", "/v1/chats/c1/leave", None),
    ("getActivity", lambda r: r.chats.get_activity("c1"), "GET", "/v1/chats/c1/activity", None),
    ("setActivity", lambda r: r.chats.set_activity("c1", text="Booking", emoji="✈️", activity_id="a1"), "PUT",
     "/v1/chats/c1/activity", {"text": "Booking", "emoji": "✈️", "activity_id": "a1"}),
    ("clearActivity", lambda r: r.chats.clear_activity("c1", activity_id="a1"), "DELETE",
     "/v1/chats/c1/activity?activity_id=a1", None),
    ("requestLocation", lambda r: r.chats.location.request("c1"), "POST", "/v1/chats/c1/location/request", None),
    ("getLocation", lambda r: r.chats.location.retrieve("c1"), "GET", "/v1/chats/c1/location", None),
    ("startTyping", lambda r: r.chats.start_typing("c1"), "POST", "/v1/chats/c1/typing", None),
    ("stopTyping", lambda r: r.chats.stop_typing("c1"), "DELETE", "/v1/chats/c1/typing", None),
    ("markChatAsRead", lambda r: r.chats.mark_as_read("c1"), "POST", "/v1/chats/c1/read", None),
    ("sendMessage", lambda r: r.messages.create(to=["bob"], message={"parts": [{"type": "text", "value": "hi"}]}),
     "POST", "/v1/messages", {"to": ["bob"], "message": {"parts": [{"type": "text", "value": "hi"}]}}),
    ("getMessageThread", lambda r: r.messages.list_messages_thread("m1", limit=10, order="desc"), "GET",
     "/v1/messages/m1/thread?limit=10&order=desc", None),
    ("sendVoiceMemoToChat", lambda r: r.chats.send_voicememo("c1", attachment_id="att"), "POST",
     "/v1/chats/c1/voicememo", {"attachment_id": "att"}),
    ("getMessage", lambda r: r.messages.retrieve("m1"), "GET", "/v1/messages/m1", None),
    ("sendReaction", lambda r: r.messages.add_reaction("m1", operation="add", type="love", part_index=0), "POST",
     "/v1/messages/m1/reactions", {"operation": "add", "type": "love", "part_index": 0}),
    ("createPaymentRequest",
     lambda r: r.payment_requests.create(amount=1500, currency="usd", description="Lesson", category="digital_goods"),
     "POST", "/v1/payment_requests",
     {"amount": 1500, "currency": "usd", "description": "Lesson", "category": "digital_goods"}),
    ("listPaymentRequests", lambda r: r.payment_requests.list(status="succeeded", limit=5), "GET",
     "/v1/payment_requests?limit=5&status=succeeded", None),
    ("getPaymentRequest", lambda r: r.payment_requests.retrieve("pr1"), "GET", "/v1/payment_requests/pr1", None),
    ("cancelPaymentRequest", lambda r: r.payment_requests.cancel("pr1"), "POST", "/v1/payment_requests/pr1/cancel", {}),
    ("requestUpload", lambda r: r.attachments.create(filename="a.png", content_type="image/png", size_bytes=3),
     "POST", "/v1/attachments", {"filename": "a.png", "content_type": "image/png", "size_bytes": 3}),
    ("getAttachment", lambda r: r.attachments.retrieve("att"), "GET", "/v1/attachments/att", None),
    ("deleteAttachment", lambda r: r.attachments.delete("att"), "DELETE", "/v1/attachments/att", None),
    ("listBlockedHandles", lambda r: r.blocked_handles.list(), "GET", "/v1/blocked_handles", None),
    ("blockHandle", lambda r: r.blocked_handles.block(handle="spam", reason="spam"), "POST", "/v1/blocked_handles",
     {"handle": "spam", "reason": "spam"}),
    ("unblockHandle", lambda r: r.blocked_handles.unblock(handle="spam"), "DELETE", "/v1/blocked_handles",
     {"handle": "spam"}),
    ("listAgentAccess", lambda r: r.access.list(), "GET", "/v1/access", None),
    ("setAgentAccess", lambda r: r.access.set("bob", rule="allow"), "PUT", "/v1/access/bob", {"rule": "allow"}),
    ("removeAgentAccess", lambda r: r.access.remove("bob"), "DELETE", "/v1/access/bob", None),
    ("listWebhookEvents", lambda r: r.webhook_events.list(), "GET", "/v1/webhook-events", None),
    ("createWebhookSubscription",
     lambda r: r.webhook_subscriptions.create(target_url="https://x.test/h", subscribed_events=["message.received"]),
     "POST", "/v1/webhook-subscriptions", {"target_url": "https://x.test/h", "subscribed_events": ["message.received"]}),
    ("listWebhookSubscriptions", lambda r: r.webhook_subscriptions.list(), "GET", "/v1/webhook-subscriptions", None),
    ("getWebhookSubscription", lambda r: r.webhook_subscriptions.retrieve("w1"), "GET",
     "/v1/webhook-subscriptions/w1", None),
    ("updateWebhookSubscription", lambda r: r.webhook_subscriptions.update("w1", is_active=False), "PUT",
     "/v1/webhook-subscriptions/w1", {"is_active": False}),
    ("deleteWebhookSubscription", lambda r: r.webhook_subscriptions.delete("w1"), "DELETE",
     "/v1/webhook-subscriptions/w1", None),
    ("lookupContact", lambda r: r.contacts.lookup(task="book a flight"), "POST", "/v1/contacts/lookup",
     {"task": "book a flight"}),
    ("getContactCard", lambda r: r.contact_card.retrieve(handle="my_bot"), "GET", "/v1/contact_card?handle=my_bot", None),
    ("setupContactCard", lambda r: r.contact_card.create(handle="my_bot", first_name="Max"), "POST",
     "/v1/contact_card", {"handle": "my_bot", "first_name": "Max"}),
    ("updateContactCard", lambda r: r.contact_card.update("my_bot", subtitle="Travel", last_name=None), "PATCH",
     "/v1/contact_card?handle=my_bot", {"subtitle": "Travel", "last_name": None}),
    ("createCall", lambda r: r.calls.create("c1", to=["bob"], idempotency_key="k1"), "POST", "/v1/chats/c1/calls",
     {"to": ["bob"]}),
    ("listCalls", lambda r: r.calls.list("c1", limit=2), "GET", "/v1/chats/c1/calls?limit=2", None),
    ("getCall", lambda r: r.calls.retrieve("call1"), "GET", "/v1/calls/call1", None),
    ("endCall", lambda r: r.calls.end("call1"), "POST", "/v1/calls/call1/end", {}),
]


@pytest.mark.parametrize("case", CASES, ids=[case[0] for case in CASES])
async def test_each_operation_sends_its_method_path_and_body(server: _Server, case: Tuple[str, Call, str, str, Any]) -> None:
    _operation, call, method, path, body = case
    await call(_relay(server))
    assert [(m, p, b) for m, p, _h, b in server.seen] == [(method, path, body)]
    assert server.seen[0][2]["authorization"] == "Bearer rel_test"


def test_every_contract_operation_has_a_python_method() -> None:
    covered = {case[0] for case in CASES} | {
        # Covered by tests/test_chats.py, test_core.py, test_login.py and test_room.py.
        "createChat", "listChats", "getChat", "getMessages", "sendMessageToChat", "shareContactWithChat",
        "listDirectory", "getOAuth2Client", "createOAuth2Client", "updateOAuth2Client", "resetOAuth2ClientSecret",
        "connectAgentWebSocket", "connectCallRoom",
    }
    # Person-only routes stay out of the agent SDK. The preexisting public
    # aggregate ratings endpoint remains outside the carried method surface.
    not_for_agents = {
        "countAgentsInAddressBook", "listSuggestedAgents", "requestAgent",
        "getMyAgentRating", "rateAgent", "deleteAgentRating", "listAgentRatings",
    }
    operations = set(re.findall(r"operationId: (\w+)", CONTRACT.read_text()))
    rest = {operation for operation in operations if not operation.startswith("webhook")}
    assert len(rest) == 66
    assert rest - covered - not_for_agents == set()


async def test_typing_and_read_retry_a_post_like_the_typescript_client(server: _Server) -> None:
    server.replies = [(503, {"error": {"message": "busy"}}), (204, None)]
    await _relay(server).chats.start_typing("c1")
    assert [m for m, *_ in server.seen] == ["POST", "POST"]


async def test_leave_chat_is_a_post_without_a_key_and_is_never_retried(server: _Server) -> None:
    server.replies = [(503, {"error": {"message": "busy"}})]
    with pytest.raises(RelayAPIError):
        await _relay(server).chats.leave_chat("c1")
    assert len(server.seen) == 1


async def test_agent_delete_is_never_retried(server: _Server) -> None:
    server.replies = [(503, {"error": {"message": "busy"}})]
    with pytest.raises(RelayAPIError):
        await _relay(server).agents.delete("my_bot")
    assert len(server.seen) == 1


async def test_call_create_sends_and_requires_an_idempotency_key(server: _Server) -> None:
    relay = _relay(server)
    with pytest.raises(ValueError):
        await relay.calls.create("c1", to=["bob"], idempotency_key="")
    await relay.calls.create("c1", to=["bob"], idempotency_key="ring-1")
    assert server.seen[0][2]["idempotency-key"] == "ring-1"


async def test_message_create_sends_the_idempotency_key_header(server: _Server) -> None:
    await _relay(server).messages.create(to=["bob"], message={"parts": [], "idempotency_key": "k7"})
    assert server.seen[0][2]["idempotency-key"] == "k7"


async def test_attachment_upload_puts_the_bytes_with_the_required_headers_and_no_token(server: _Server) -> None:
    allocation: Any = {
        "attachment_id": "att",
        "upload_url": f"{server.base_url}/upload/att",
        "download_url": "",
        "http_method": "PUT",
        "expires_at": "",
        "required_headers": {"content-type": "image/png"},
    }
    await _relay(server).attachments.upload(allocation, b"PNG")
    method, path, headers, body = server.seen[0]
    assert (method, path, headers["content-type"], body) == ("PUT", "/upload/att", "image/png", b"PNG")
    assert "authorization" not in headers


async def test_one_of_rules_refuse_before_sending(server: _Server) -> None:
    relay = _relay(server)
    with pytest.raises(ValueError):
        await relay.contacts.lookup(handle="a", task="b")
    with pytest.raises(ValueError):
        await relay.chats.send_voicememo("c1")
    with pytest.raises(TypeError):
        await relay.contact_card.update("my_bot", nickname="x")
    assert server.seen == []
