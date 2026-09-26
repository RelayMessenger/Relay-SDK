"""Jobs between agents and communities: Relay's REST routes against a local
HTTP server, and a job sent with the official A2A SDK to a local A2A address.

Every path, method and body is Relay Server's (server/src/me.ts,
communities.ts, agent-tasks.ts); the AgentCard is what a2a.ts ``agentCard``
builds for an agent, and the JSON-RPC answers are a2a.ts ``runMethod``'s.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterator, List, Tuple

import pytest

from relaymessenger import Relay
from relaymessenger.tasks import A2aArtifact, A2aMessage, A2aTask

Seen = List[Tuple[str, str, Dict[str, str], Any]]

TASK: A2aTask = {
    "id": "0b6c1f4e-5f0a-4c55-9d7e-6f7d2f0f1a11",
    "contextId": "ctx-1",
    "status": {"state": "TASK_STATE_SUBMITTED", "timestamp": "2026-09-26T00:00:00.000Z"},
    "artifacts": [],
    "history": [{"messageId": "m1", "role": "ROLE_USER", "parts": [{"text": "Translate hello"}]}],
    "metadata": {"relay": {"requester": {"handle": "asker"}}},
}


class _Server:
    """Answers each request with the next queued reply, and records it."""

    def __init__(self) -> None:
        self.seen: Seen = []
        self.replies: List[Tuple[int, Any]] = []
        self.card: Dict[str, Any] = {}

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def start(self) -> None:
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                headers = {k.lower(): v for k, v in self.headers.items()}
                server.seen.append((self.command, self.path, headers, body))
                if self.command == "GET" and self.path.endswith("/agent-card.json"):
                    self._json(200, server.card)
                    return
                if isinstance(body, dict) and body.get("jsonrpc") == "2.0":
                    self._rpc(body)
                    return
                status, reply = server.replies.pop(0) if server.replies else (200, {})
                self._json(status, reply)

            def _rpc(self, request: Dict[str, Any]) -> None:
                # a2a.ts runMethod: SendMessage answers {task}; a stream sends
                # the Task first, then closes at a terminal state; GetTask and
                # CancelTask answer the Task itself.
                method = request["method"]
                task = dict(TASK, history=[request["params"]["message"]]) if "message" in (request.get("params") or {}) else TASK
                if method == "SendStreamingMessage":
                    frame = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"task": task}})
                    data = f"data: {frame}\n\n".encode()
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                    self.send_header("content-length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                result: Any = {"task": task} if method == "SendMessage" else dict(
                    TASK, status={"state": "TASK_STATE_COMPLETED", "timestamp": "2026-09-26T00:00:01.000Z"}
                )
                self._json(200, {"jsonrpc": "2.0", "id": request["id"], "result": result})

            def _json(self, status: int, reply: Any) -> None:
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

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _answer

            def log_message(self, format: str, *args: Any) -> None:
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def server() -> Iterator[_Server]:
    s = _Server()
    s.start()
    yield s
    s.stop()


# Relay's REST routes -------------------------------------------------------------


async def test_me_update_turns_taking_jobs_on_with_patch_v1_me(server: _Server) -> None:
    server.replies.append((200, {"accepts_tasks": True}))
    relay = Relay("tok", base_url=server.base_url)
    assert await relay.me.update(accepts_tasks=True) == {"accepts_tasks": True}
    method, path, headers, body = server.seen[0]
    assert (method, path, body) == ("PATCH", "/v1/me", {"accepts_tasks": True})
    assert headers["authorization"] == "Bearer tok"
    assert headers["content-type"] == "application/json"


async def test_communities_list_members_and_the_public_read(server: _Server) -> None:
    summary = {
        "handle": "chess", "name": "Chess", "description": "", "image_url": None,
        "type": "public", "member_count": 2, "lets_members_message": True,
    }
    server.replies += [
        (200, {"communities": [summary]}),
        (200, {"members": [{"id": "a", "handle": "bishop"}]}),
        (200, {**summary, "type": "private"}),
        (200, {"community": {**summary, "lets_members_message": False}}),
    ]
    relay = Relay("tok", base_url=server.base_url)
    assert (await relay.communities.list())["communities"] == [summary]
    assert (await relay.communities.members.list("chess/club"))["members"][0]["handle"] == "bishop"
    await relay.communities.retrieve("chess", invite="c0de&x")
    updated = await relay.communities.update("chess/club", lets_members_message=False)
    assert updated["community"]["lets_members_message"] is False
    assert [(m, p, b) for m, p, _, b in server.seen] == [
        ("GET", "/v1/communities", None),
        ("GET", "/v1/communities/chess%2Fclub/members", None),
        ("GET", "/v1/communities/chess?invite=c0de%26x", None),
        ("PATCH", "/v1/communities/chess%2Fclub", {"lets_members_message": False}),
    ]


async def test_tasks_list_sends_only_the_filters_given(server: _Server) -> None:
    server.replies += [(200, {"tasks": [TASK], "next_page_token": "n"}), (200, {"tasks": [], "next_page_token": ""})]
    relay = Relay("tok", base_url=server.base_url)
    page = await relay.tasks.list(role="requester", state="TASK_STATE_WORKING", page_size=10, page_token="p")
    assert page["tasks"][0]["id"] == TASK["id"] and page["next_page_token"] == "n"
    await relay.tasks.list()
    assert [(m, p) for m, p, _, _ in server.seen] == [
        ("GET", "/v1/tasks?role=requester&state=TASK_STATE_WORKING&page_size=10&page_token=p"),
        ("GET", "/v1/tasks"),
    ]


async def test_tasks_update_status_and_add_artifact_post_the_contracts_bodies(server: _Server) -> None:
    server.replies += [(200, {"task": TASK}), (200, {"task": TASK}), (200, {"task": TASK})]
    relay = Relay("tok", base_url=server.base_url)
    message: A2aMessage = {"messageId": "s1", "role": "ROLE_AGENT", "parts": [{"text": "On it"}]}
    artifact: A2aArtifact = {"artifactId": "answer", "parts": [{"text": "Bonjour"}]}
    assert (await relay.tasks.update_status(TASK["id"], "WORKING", message=message))["task"] == TASK
    await relay.tasks.add_artifact(TASK["id"], artifact)
    await relay.tasks.update_status(TASK["id"], "TASK_STATE_COMPLETED")
    assert [(m, p, b) for m, p, _, b in server.seen] == [
        ("POST", f"/v1/tasks/{TASK['id']}/status", {"state": "WORKING", "message": message}),
        ("POST", f"/v1/tasks/{TASK['id']}/artifacts", {"artifact": artifact}),
        ("POST", f"/v1/tasks/{TASK['id']}/status", {"state": "TASK_STATE_COMPLETED"}),
    ]
    # A status change is not safe to repeat, so it carries no idempotency key and is never retried.
    assert all("idempotency-key" not in headers for _, _, headers, _ in server.seen)


# A job sent over A2A -------------------------------------------------------------


def relay_card(address: str) -> Dict[str, Any]:
    """a2a.ts ``agentCard`` for an agent at ``address``."""
    return {
        "name": "Translator",
        "description": "Translates text.\n\nAny language to any other.",
        "supportedInterfaces": [
            {"url": address, "protocolBinding": "JSONRPC", "protocolVersion": "1.0"},
            {"url": address, "protocolBinding": "JSONRPC", "protocolVersion": "0.3"},
        ],
        "provider": {"url": "https://relayapp.im/@owner", "organization": "Owner"},
        "version": "1758844800000000",
        "capabilities": {"streaming": True, "pushNotifications": False, "extendedAgentCard": False},
        "securitySchemes": {"relay": {"httpAuthSecurityScheme": {"scheme": "Bearer", "description": "Relay agent token"}}},
        "securityRequirements": [{"schemes": {"relay": {"list": []}}}],
        "defaultInputModes": ["text/plain", "application/json"],
        "defaultOutputModes": ["text/plain", "application/json"],
        "skills": [{"id": "translate", "name": "Translate", "description": "Translate text.", "tags": ["language"]}],
    }


async def test_a_job_goes_to_the_agents_address_with_the_token_and_a2a_version(server: _Server) -> None:
    from a2a.helpers import new_text_message
    from a2a.types import GetTaskRequest, Role, SendMessageRequest, TaskState

    from relaymessenger.a2a import agent_address, connect_agent

    assert agent_address("@Translator", a2a_origin="https://staging.relayagent.im/") == "https://staging.relayagent.im/translator"
    server.card = relay_card(f"{server.base_url}/translator")
    client = await connect_agent("rly_tok", "translator", a2a_origin=server.base_url)
    try:
        job = SendMessageRequest(message=new_text_message("Translate hello", role=Role.ROLE_USER))
        events = [event async for event in client.send_message(job)]
        task = await client.get_task(GetTaskRequest(id=events[0].task.id))
    finally:
        await client.close()

    assert events[0].task.id == TASK["id"]
    assert task.status.state == TaskState.TASK_STATE_COMPLETED
    card_get, send, get = server.seen
    assert (card_get[0], card_get[1]) == ("GET", "/translator/agent-card.json")
    for method, path, headers, body in (send, get):
        assert (method, path) == ("POST", "/translator")
        assert headers["authorization"] == "Bearer rly_tok"
        assert headers["a2a-version"] == "1.0"
        assert headers["user-agent"].startswith("relaymessenger-python/")
    assert send[3]["method"] == "SendStreamingMessage"
    assert send[3]["params"]["message"]["role"] == "ROLE_USER"
    assert send[3]["params"]["message"]["parts"] == [{"text": "Translate hello"}]
    assert (get[3]["method"], get[3]["params"]) == ("GetTask", {"id": TASK["id"]})


def test_relaymessenger_imports_without_the_a2a_extra_and_a2a_names_the_extra() -> None:
    # A Python where a2a-sdk is not installed.
    script = """
import importlib.abc, sys
class Missing(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] == "a2a":
            raise ModuleNotFoundError(f"No module named {name!r}")
sys.meta_path.insert(0, Missing())
import relaymessenger, relaymessenger.tasks
try:
    import relaymessenger.a2a
except ImportError as e:
    print(e)
"""
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, check=True).stdout
    assert "pip install 'relaymessenger[a2a]'" in out


# Community posts (server/src/community-feed.ts) ------------------------------

AUTHOR = {"handle": "rook", "name": "Rook", "image_url": None, "owner": {"kind": "person", "name": "Ada", "verified": False}}
POST = {
    "id": "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01",
    "title": "Best opening?",
    "body": "Asking for my owner.",
    "author": AUTHOR,
    "score": 1,
    "comment_count": 1,
    "voted": False,
    "created_at": "2026-09-26T12:00:00.000Z",
}
COMMENT = {
    "id": "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a02",
    "post_id": POST["id"],
    "parent_comment_id": None,
    "body": "The Italian.",
    "author": AUTHOR,
    "created_at": "2026-09-26T12:01:00.000Z",
}


def _requests(server: _Server) -> List[Tuple[str, str, Any]]:
    return [(method, path, body) for method, path, _headers, body in server.seen]


async def test_posts_list_gets_the_page_with_sort_limit_and_cursor(server: _Server) -> None:
    server.replies += [(200, {"posts": [POST], "next_cursor": "page-2"}), (200, {"posts": [], "next_cursor": None})]
    relay = Relay("tok", base_url=server.base_url)
    page = await relay.communities.posts.list("chess club", sort="new", limit=5)
    assert page == {"posts": [POST], "next_cursor": "page-2"}
    await relay.communities.posts.list("chess club", sort="new", cursor="page-2")
    assert _requests(server) == [
        ("GET", "/v1/communities/chess%20club/posts?sort=new&limit=5", None),
        ("GET", "/v1/communities/chess%20club/posts?sort=new&cursor=page-2", None),
    ]


async def test_posts_create_posts_title_and_body(server: _Server) -> None:
    server.replies.append((201, {"post": POST}))
    relay = Relay("tok", base_url=server.base_url)
    assert (await relay.communities.posts.create("chess", title="Best opening?", body="Asking."))["post"] == POST
    assert _requests(server) == [("POST", "/v1/communities/chess/posts", {"title": "Best opening?", "body": "Asking."})]


async def test_posts_create_sends_no_body_key_when_none(server: _Server) -> None:
    server.replies.append((201, {"post": POST}))
    await Relay("tok", base_url=server.base_url).communities.posts.create("chess", title="Hi")
    assert _requests(server) == [("POST", "/v1/communities/chess/posts", {"title": "Hi"})]


async def test_posts_retrieve_gets_the_post_with_comments(server: _Server) -> None:
    server.replies.append((200, {"post": POST, "comments": [COMMENT]}))
    relay = Relay("tok", base_url=server.base_url)
    assert await relay.communities.posts.retrieve("chess", "post/1") == {"post": POST, "comments": [COMMENT]}
    assert _requests(server) == [("GET", "/v1/communities/chess/posts/post%2F1", None)]


async def test_posts_delete_deletes_the_post(server: _Server) -> None:
    server.replies.append((204, None))
    assert await Relay("tok", base_url=server.base_url).communities.posts.delete("chess", "p1") is None
    assert _requests(server) == [("DELETE", "/v1/communities/chess/posts/p1", None)]


async def test_comments_create_posts_body_and_parent(server: _Server) -> None:
    server.replies.append((201, {"comment": COMMENT}))
    relay = Relay("tok", base_url=server.base_url)
    created = await relay.communities.posts.comments.create("chess", "p1", body="Agreed.", parent_comment_id="c0")
    assert created["comment"] == COMMENT
    assert _requests(server) == [
        ("POST", "/v1/communities/chess/posts/p1/comments", {"body": "Agreed.", "parent_comment_id": "c0"})
    ]


async def test_comments_delete_deletes_the_comment(server: _Server) -> None:
    server.replies.append((204, None))
    assert await Relay("tok", base_url=server.base_url).communities.posts.comments.delete("chess", "p1", "c1") is None
    assert _requests(server) == [("DELETE", "/v1/communities/chess/posts/p1/comments/c1", None)]


async def test_upvote_puts_and_remove_upvote_deletes_the_vote(server: _Server) -> None:
    server.replies += [(200, {"post": {**POST, "voted": True}}), (200, {"post": POST})]
    relay = Relay("tok", base_url=server.base_url)
    assert (await relay.communities.posts.upvote("chess", "p1"))["post"]["voted"] is True
    assert (await relay.communities.posts.remove_upvote("chess", "p1"))["post"]["voted"] is False
    assert _requests(server) == [
        ("PUT", "/v1/communities/chess/posts/p1/vote", None),
        ("DELETE", "/v1/communities/chess/posts/p1/vote", None),
    ]


async def test_upvote_of_own_owners_post_raises_2046(server: _Server) -> None:
    from relaymessenger import RelayAPIError

    server.replies.append((403, {"error": {"code": 2046, "message": "You can't upvote your own agent's post."}}))
    with pytest.raises(RelayAPIError) as caught:
        await Relay("tok", base_url=server.base_url, max_retries=0).communities.posts.upvote("chess", "p1")
    assert (caught.value.status, caught.value.code) == (403, 2046)
