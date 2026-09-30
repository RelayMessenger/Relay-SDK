"""Tasks between agents and communities: Relay's REST routes against a local
HTTP server, and a task or a message sent with the official A2A SDK to a local
A2A address.

Every path, method and body is Relay Server's (server/src/me.ts,
communities.ts, agent-tasks.ts); the AgentCard is what a2a.ts ``agentCard``
builds for an agent, and the JSON-RPC answers are a2a.ts ``runMethod``'s.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterator, List, Optional, Tuple

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
        #: a2a.ts message mode: an agent that does not accept tasks answers
        #: SendMessage with {message}, and a stream sends that one Message.
        self.reply: Optional[A2aMessage] = None
        #: When set, a JSON-RPC POST is answered 307 to this URL.
        self.redirect_to: Optional[str] = None
        #: What GetExtendedAgentCard answers (a2a.ts has no extended card).
        self.extended_card: Optional[Dict[str, Any]] = None

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
                if isinstance(body, dict) and body.get("jsonrpc") == "2.0" and server.redirect_to:
                    self.send_response(307)
                    self.send_header("location", server.redirect_to)
                    self.send_header("content-length", "0")
                    self.end_headers()
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
                if method == "GetExtendedAgentCard" and server.extended_card is not None:
                    self._json(200, {"jsonrpc": "2.0", "id": request["id"], "result": server.extended_card})
                    return
                if server.reply is not None and method in ("SendMessage", "SendStreamingMessage"):
                    self._message(request, method)
                    return
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

            def _message(self, request: Dict[str, Any], method: str) -> None:
                answer = {"jsonrpc": "2.0", "id": request["id"], "result": {"message": server.reply}}
                if method == "SendMessage":
                    self._json(200, answer)
                    return
                data = f"data: {json.dumps(answer)}\n\n".encode()
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

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


async def test_me_update_turns_accepting_tasks_on_with_patch_v1_me(server: _Server) -> None:
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
        "rules": [], "links": [],
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


async def test_communities_update_takes_only_lets_members_message(server: _Server) -> None:
    # The community feed is removed: no notifications bell. PATCH
    # /v1/communities/{handle} takes lets_members_message alone.
    relay = Relay("tok", base_url=server.base_url)
    with pytest.raises(TypeError):
        await relay.communities.update("chess")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        await relay.communities.update("chess", lets_members_message=True, notifications=True)  # type: ignore[call-arg]
    assert server.seen == []


async def test_communities_join_posts_the_invite_code_and_leave_posts_nothing(server: _Server) -> None:
    # Relay-Server 6645d5f8 (PR 407): POST /v1/communities/{handle}/join with
    # an optional invite_code answers 200 {community}; POST .../leave answers 204.
    community = {
        "handle": "chess", "name": "Chess", "description": "", "image_url": None,
        "type": "private", "member_count": 3, "lets_members_message": True,
        "rules": [{"title": "No spam", "description": "One message a day."}],
        "links": [{"label": "FIDE laws", "url": "https://www.fide.com/laws"}],
    }
    server.replies += [(200, {"community": community}), (200, {"community": community}), (204, None)]
    relay = Relay("tok", base_url=server.base_url)
    joined = await relay.communities.join("chess/club", invite_code="k3y")
    assert joined["community"]["rules"][0]["title"] == "No spam"
    await relay.communities.join("chess")
    assert await relay.communities.leave("chess/club") is None
    assert [(m, p, b) for m, p, _, b in server.seen] == [
        ("POST", "/v1/communities/chess%2Fclub/join", {"invite_code": "k3y"}),
        ("POST", "/v1/communities/chess/join", {}),
        ("POST", "/v1/communities/chess%2Fclub/leave", None),
    ]


async def test_communities_join_with_a_wrong_code_is_not_found(server: _Server) -> None:
    from relaymessenger import RelayAPIError

    server.replies.append((404, {"error": {"status": 404, "code": 2040, "message": "Community was not found."}}))
    relay = Relay("tok", base_url=server.base_url)
    with pytest.raises(RelayAPIError) as refused:
        await relay.communities.join("chess", invite_code="wrong")
    assert (refused.value.status, refused.value.code) == (404, 2040)


def test_a_communitys_membership_has_every_field_the_contract_requires() -> None:
    from relaymessenger.client import CommunityMembership

    assert "notifications" not in _contract_required("CommunityMembership")
    assert {"rules", "links"} <= set(_contract_required("CommunityMembership"))
    assert sorted(CommunityMembership.__required_keys__) == sorted(_contract_required("CommunityMembership"))


def _contract_required(schema: str) -> List[str]:
    """The ``required`` list of one ``components.schemas`` entry in the carried
    contract (contracts/relay-v1-openapi.yaml), read from its YAML text."""
    lines = (Path(__file__).resolve().parents[3] / "contracts" / "relay-v1-openapi.yaml").read_text().splitlines()
    start = lines.index(f"    {schema}:")
    required = lines.index("      required:", start)
    names: List[str] = []
    for line in lines[required + 1 :]:
        if not line.startswith("        - "):
            break
        names.append(line.removeprefix("        - ").strip())
    return names


def test_a_public_communitys_about_box_has_every_field_the_contract_requires() -> None:
    # Relay-Server 0ccaba4b (PR 394): rules, links and created_at. contributor_count
    # counted posts and comments, and left with the community feed.
    from relaymessenger.client import CommunityLink, CommunityRule, PublicCommunity

    assert sorted(PublicCommunity.__required_keys__) == sorted(_contract_required("PublicCommunity"))
    assert sorted(CommunityRule.__required_keys__) == sorted(_contract_required("CommunityRule"))
    assert sorted(CommunityLink.__required_keys__) == sorted(_contract_required("CommunityLink"))


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


async def test_tasks_reply_posts_the_message_once(server: _Server) -> None:
    server.replies += [(200, {"task": TASK})]
    relay = Relay("tok", base_url=server.base_url)
    message: A2aMessage = {"messageId": "r1", "role": "ROLE_AGENT", "parts": [{"text": "Direct message response"}]}
    assert (await relay.tasks.reply(TASK["id"], message))["task"] == TASK
    assert [(m, p, b) for m, p, _, b in server.seen] == [
        ("POST", f"/v1/tasks/{TASK['id']}/reply", {"message": message}),
    ]
    # A second reply is refused, so the first carries no idempotency key.
    assert all("idempotency-key" not in headers for _, _, headers, _ in server.seen)


# A task or a message sent over A2A ---------------------------------------------


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


async def test_a_task_goes_to_the_agents_address_with_the_token_and_a2a_version(server: _Server) -> None:
    from a2a.helpers import new_text_message
    from a2a.types import GetTaskRequest, Role, SendMessageRequest, TaskState

    from relaymessenger.a2a import agent_address, connect_agent

    # Each agent is its own origin under the agent domain; "_" is written "-".
    assert agent_address("@translator", a2a_origin="https://staging.relayagent.im/") == "https://translator.staging.relayagent.im"
    assert agent_address("two_words") == "https://two-words.relayagent.im"
    # "__" is refused only as the 3rd and 4th characters (RFC 5891 4.2.3.1).
    assert agent_address("abc__d") == "https://abc--d.relayagent.im"
    # A local Relay Server serves agents under its own /a2a.
    assert agent_address("two_words", a2a_origin="http://localhost:8790/a2a/") == "http://localhost:8790/a2a/two_words"
    server.card = relay_card(f"{server.base_url}/a2a/translator")
    client = await connect_agent("rly_tok", "translator", a2a_origin=f"{server.base_url}/a2a")
    try:
        request = SendMessageRequest(message=new_text_message("Translate hello", role=Role.ROLE_USER))
        events = [event async for event in client.send_message(request)]
        task = await client.get_task(GetTaskRequest(id=events[0].task.id))
    finally:
        await client.close()

    assert events[0].task.id == TASK["id"]
    assert task.status.state == TaskState.TASK_STATE_COMPLETED
    card_get, send, get = server.seen
    assert (card_get[0], card_get[1]) == ("GET", "/a2a/translator/.well-known/agent-card.json")
    for method, path, headers, body in (send, get):
        assert (method, path) == ("POST", "/a2a/translator")
        assert headers["authorization"] == "Bearer rly_tok"
        assert headers["a2a-version"] == "1.0"
        assert headers["user-agent"].startswith("relaymessenger-python/")
    assert send[3]["method"] == "SendStreamingMessage"
    assert send[3]["params"]["message"]["role"] == "ROLE_USER"
    assert send[3]["params"]["message"]["parts"] == [{"text": "Translate hello"}]
    assert (get[3]["method"], get[3]["params"]) == ("GetTask", {"id": TASK["id"]})


# Everything that is not exactly Relay-Server a2a.ts HANDLE, /^[a-z][a-z0-9_]{2,31}$/.
HOSTILE_HANDLES = [
    "attacker.example/",  # the review's leak: the address became https://attacker.example
    "attacker.example",
    "evil/../translator",
    "..",
    "user@attacker.example",
    "attacker:8443",
    "translator#x",
    "translator?x",
    "trаnslator",  # Cyrillic "а"
    "\u212aelvin",  # KELVIN SIGN, which str.lower() turns into ASCII "k"
    "Translator",
    " translator",
    "translator\n",
    "two-words",
    "tr",
    "t" * 33,
    "xn__abc",  # host label xn--abc, an invalid A-label (RFC 5891 4.2.3.1)
    "ab__c",
    "abc_",  # host label abc-, ends with a hyphen
    "",
    "@",
]


@pytest.mark.parametrize("handle", HOSTILE_HANDLES)
async def test_a_handle_outside_the_servers_grammar_is_refused_before_any_request(server: _Server, handle: str) -> None:
    from relaymessenger.a2a import agent_address, connect_agent

    with pytest.raises(ValueError, match="is not a Relay handle"):
        agent_address(handle)
    with pytest.raises(ValueError, match="is not a Relay handle"):
        agent_address(handle, a2a_origin=f"{server.base_url}/a2a")
    with pytest.raises(ValueError, match="is not a Relay handle"):
        await connect_agent("rly_tok", handle, a2a_origin=f"{server.base_url}/a2a")
    assert server.seen == []


@pytest.mark.parametrize(
    "interface",
    [
        "https://attacker.example/",
        "http://127.0.0.1:1/a2a/translator",  # same host, another port
        "https://127.0.0.1/a2a/translator",  # same host, another scheme
    ],
)
async def test_a_card_naming_an_interface_off_the_addresss_origin_gets_no_token(server: _Server, interface: str) -> None:
    from relaymessenger.a2a import connect_agent

    card = relay_card(f"{server.base_url}/a2a/translator")
    card["supportedInterfaces"].append({"url": interface, "protocolBinding": "JSONRPC", "protocolVersion": "1.0"})
    server.card = card
    with pytest.raises(ValueError, match="not on the agent's own origin"):
        await connect_agent("rly_tok", "translator", a2a_origin=f"{server.base_url}/a2a")
    # Only the card was fetched, and without the token.
    assert [(method, path) for method, path, _, _ in server.seen] == [("GET", "/a2a/translator/.well-known/agent-card.json")]
    assert "authorization" not in server.seen[0][2]


@pytest.mark.parametrize(
    "schemes, requirement",
    [
        ({"relay": {"apiKeySecurityScheme": {"location": "header", "name": "X-Relay-Token"}}}, "relay"),
        ({"relay": {"httpAuthSecurityScheme": {"scheme": "Basic"}}}, "relay"),
        ({"other": {"apiKeySecurityScheme": {"location": "header", "name": "X-Relay-Token"}}}, "other"),
        # Relay's Bearer beside a second scheme: the token goes only as the Bearer.
        (
            {
                "relay": {"httpAuthSecurityScheme": {"scheme": "Bearer"}},
                "other": {"apiKeySecurityScheme": {"location": "header", "name": "X-Relay-Token"}},
            },
            "other relay",  # the A2A SDK stops at the first credential it applies
        ),
    ],
)
async def test_a_card_that_names_another_scheme_gets_no_token(server: _Server, schemes: Dict[str, Any], requirement: str) -> None:
    # A same-origin card may not choose where the token goes: Relay's cards
    # publish one scheme, the "relay" HTTP Bearer, and nothing else gets it.
    from a2a.types import GetTaskRequest

    from relaymessenger.a2a import connect_agent

    card = relay_card(f"{server.base_url}/a2a/translator")
    card["securitySchemes"] = schemes
    card["securityRequirements"] = [{"schemes": {name: {"list": []}}} for name in requirement.split()]
    server.card = card
    client = await connect_agent("rly_tok", "translator", a2a_origin=f"{server.base_url}/a2a")
    try:
        await client.get_task(GetTaskRequest(id=TASK["id"]))
    finally:
        await client.close()
    rpc = server.seen[1]
    assert rpc[0] == "POST"
    carrying = {name: value for name, value in rpc[2].items() if "rly_tok" in value}
    assert carrying == ({"authorization": "Bearer rly_tok"} if "relay" in schemes and "Bearer" in str(schemes["relay"]) else {}), rpc[2]


async def test_a_redirected_call_is_never_followed_even_when_the_callers_client_follows() -> None:
    import httpx
    from a2a.client import ClientConfig
    from a2a.types import GetTaskRequest

    from relaymessenger.a2a import connect_agent

    agent, attacker = _Server(), _Server()
    agent.start()
    attacker.start()
    try:
        agent.card = relay_card(f"{agent.base_url}/a2a/translator")
        agent.redirect_to = f"{attacker.base_url}/steal"
        config = ClientConfig(streaming=False, httpx_client=httpx.AsyncClient(follow_redirects=True))
        client = await connect_agent("rly_tok", "translator", a2a_origin=f"{agent.base_url}/a2a", config=config)
        try:
            with pytest.raises(Exception, match="redirect"):
                await client.get_task(GetTaskRequest(id=TASK["id"]))
        finally:
            await client.close()
        assert attacker.seen == []
    finally:
        agent.stop()
        attacker.stop()


async def test_a_card_swapped_by_an_extended_card_refresh_gets_no_token_even_through_a_redirect() -> None:
    # The client's card can change after connect_agent vetted it:
    # get_extended_agent_card replaces it. A replacement that moves the relay
    # scheme into an API-key header must not get the token, not even when the
    # next call is redirected by a client that follows redirects.
    import httpx
    from a2a.client import ClientConfig
    from a2a.types import GetExtendedAgentCardRequest, GetTaskRequest

    from relaymessenger.a2a import connect_agent

    agent, attacker = _Server(), _Server()
    agent.start()
    attacker.start()
    try:
        card = relay_card(f"{agent.base_url}/a2a/translator")
        card["capabilities"] = dict(card["capabilities"], extendedAgentCard=True)
        agent.card = card
        agent.extended_card = dict(
            card, securitySchemes={"relay": {"apiKeySecurityScheme": {"location": "header", "name": "X-Relay-Token"}}}
        )
        config = ClientConfig(streaming=False, httpx_client=httpx.AsyncClient(follow_redirects=True))
        client = await connect_agent("rly_tok", "translator", a2a_origin=f"{agent.base_url}/a2a", config=config)
        try:
            await client.get_extended_agent_card(GetExtendedAgentCardRequest())
            agent.redirect_to = f"{attacker.base_url}/steal"
            # It carries no token, so the caller's client may follow it.
            await client.get_task(GetTaskRequest(id=TASK["id"]))
        finally:
            await client.close()
        card_get, refresh, redirected = agent.seen
        # The refresh went out under the vetted Bearer card, as Authorization.
        assert refresh[3]["method"] == "GetExtendedAgentCard"
        assert {name: value for name, value in refresh[2].items() if "rly_tok" in value} == {"authorization": "Bearer rly_tok"}
        # After it, the token went nowhere: not to the agent, not to the attacker.
        assert redirected[3]["method"] == "GetTask"
        assert not any("rly_tok" in value for value in redirected[2].values()), redirected[2]
        assert not any("rly_tok" in value for _, _, headers, _ in attacker.seen for value in headers.values()), attacker.seen
    finally:
        agent.stop()
        attacker.stop()


async def test_the_redirect_guard_finds_the_token_in_any_header() -> None:
    import httpx

    from relaymessenger.a2a import _refuse_redirects_with

    agent, attacker = _Server(), _Server()
    agent.start()
    attacker.start()
    try:
        agent.redirect_to = f"{attacker.base_url}/steal"
        async with httpx.AsyncClient(follow_redirects=True) as client:
            _refuse_redirects_with(client, "rly_tok")
            with pytest.raises(httpx.RemoteProtocolError, match="never follows a redirect"):
                await client.post(f"{agent.base_url}/a2a/translator", json={"jsonrpc": "2.0", "id": 1, "method": "GetTask"}, headers={"X-Relay-Token": "rly_tok"})
        assert attacker.seen == []
    finally:
        agent.stop()
        attacker.stop()


REPLY: A2aMessage = {
    "messageId": "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a3a",
    "contextId": "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a3b",
    "role": "ROLE_AGENT",
    "parts": [{"text": "I answer questions about Relay."}],
}


def message_card(address: str) -> Dict[str, Any]:
    """a2a.ts ``agentCard`` for an agent that does not accept tasks (MESSAGE_MODES)."""
    return dict(
        relay_card(address),
        defaultInputModes=["text/plain", "application/a2ui+json"],
        defaultOutputModes=["text/plain", "application/json", "application/a2ui+json"],
    )


@pytest.mark.parametrize("streaming", [True, False])
async def test_an_agent_that_does_not_accept_tasks_answers_with_one_message(server: _Server, streaming: bool) -> None:
    from a2a.client import ClientConfig
    from a2a.helpers import new_text_message
    from a2a.types import Role, SendMessageRequest

    from relaymessenger.a2a import connect_agent

    server.card = message_card(f"{server.base_url}/a2a/relay")
    server.reply = REPLY
    config = None if streaming else ClientConfig(streaming=False)
    client = await connect_agent("rly_tok", "relay", a2a_origin=f"{server.base_url}/a2a", config=config)
    try:
        request = SendMessageRequest(message=new_text_message("What can you do?", role=Role.ROLE_USER))
        events = [event async for event in client.send_message(request)]
    finally:
        await client.close()

    assert len(events) == 1
    assert events[0].HasField("message") and not events[0].HasField("task")
    assert events[0].message.message_id == REPLY["messageId"]
    assert events[0].message.context_id == REPLY["contextId"]
    assert events[0].message.role == Role.ROLE_AGENT
    assert [part.text for part in events[0].message.parts] == ["I answer questions about Relay."]
    send = server.seen[1]
    assert send[3]["method"] == ("SendStreamingMessage" if streaming else "SendMessage")
    assert send[2]["authorization"] == "Bearer rly_tok"


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
