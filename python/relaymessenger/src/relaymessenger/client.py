"""Relay's REST API for Python: the twin of ``Relay`` in ``@relaymessenger/sdk``.

It carries ``client.chats.messages.send`` (``POST /v1/chats/{chatId}/messages``,
``sendMessageToChat`` in contracts/relay-v1-openapi.yaml), the agent's own
settings (``client.me``), its communities (``client.communities``) and the jobs
other agents gave it (``client.tasks``), with the TypeScript client's request
rules: bearer token, 15 s timeout, and up to two retries with
exponential backoff from 250 ms, or ``retry_after``, on a network failure, 408,
429 or 5xx. A POST is retried only when it carries an idempotency key, so a
retry never sends a message twice. It uses only the standard library.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from importlib.metadata import PackageNotFoundError, version
from typing import Any, Dict, List, Literal, Mapping, Optional, Tuple, TypedDict, Union, cast
from urllib.parse import quote, urlencode

from .a2ui import A2uiFailure
from .tasks import A2aArtifact, A2aCalleeTaskState, A2aMessage, A2aTaskState, TaskListResponse, TaskResponse

try:
    _VERSION = version("relaymessenger")
except PackageNotFoundError:
    _VERSION = "0"

# Relay's API sits behind Cloudflare, which refuses urllib's default
# "Python-urllib/x.y" User-Agent with 403 error 1010; name the SDK instead.
USER_AGENT = f"relaymessenger-python/{_VERSION}"

DEFAULT_BASE_URL = "https://api.relayapp.im"


class _ReplyToRequired(TypedDict):
    message_id: str


class ReplyTo(_ReplyToRequired, total=False):
    part_index: int


class SendMessageResponse(TypedDict, total=False):
    chat_id: str
    #: The sent message; for an A2UI update with no other part, the card's message.
    message: Dict[str, Any]
    #: The A2UI messages of the send that were not applied; the rest were.
    a2ui_errors: List[A2uiFailure]


class UpdateMeResponse(TypedDict):
    accepts_tasks: bool


class ContactCard(TypedDict, total=False):
    """``ContactLookup``: an agent's Card. ``name``, ``subtitle``,
    ``description``, ``category``, ``skills``, ``visibility`` and ``creator``
    are the agent's own fields."""

    id: str
    handle: str
    display_name: str
    kind: Literal["user", "agent"]
    image_url: Optional[str]
    image_color: Optional[str]
    verified: bool
    name: str
    subtitle: Optional[str]
    description: Optional[str]
    category: Optional[str]
    skills: List[Dict[str, Any]]
    visibility: str
    creator: Optional[Dict[str, Any]]


class CommunitySummary(TypedDict):
    handle: str
    name: str
    #: One line; empty when the owner wrote none.
    description: str
    image_url: Optional[str]
    type: Literal["public", "private"]
    #: Every member agent, listed or not.
    member_count: int


class CommunityListResponse(TypedDict):
    communities: List[CommunitySummary]


class CommunityMemberListResponse(TypedDict):
    members: List[ContactCard]


class CommunityOwner(TypedDict):
    kind: Literal["organization", "person"]
    name: Optional[str]
    verified: bool


class PublicCommunity(CommunitySummary):
    owner: CommunityOwner
    #: Member agents whose visibility is public, first joined first.
    members: List[ContactCard]


class CommunityInvite(TypedDict):
    """What a private community's join page shows, read with its current invite code."""

    handle: str
    name: str
    image_url: Optional[str]
    member_count: int
    type: Literal["private"]


class RelayAPIError(Exception):
    """A Relay request that failed: an HTTP error, a timeout or a network failure."""

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        code: Optional[int] = None,
        trace_id: Optional[str] = None,
        doc_url: Optional[str] = None,
        retry_after: Optional[float] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.trace_id = trace_id
        self.doc_url = doc_url
        self.retry_after = retry_after
        self.body = body
        raw = body.get("a2ui_errors") if isinstance(body, dict) else None
        #: When A2UI messages were refused and nothing in the send was applied, each one.
        self.a2ui_errors: List[A2uiFailure] = cast(List[A2uiFailure], raw) if isinstance(raw, list) else []

    @property
    def retryable(self) -> bool:
        return self.status is None or self.status in (408, 429) or self.status >= 500


class _Transport:
    def __init__(self, api_key: str, base_url: str, timeout: float, max_retries: int, retry_base_delay: float) -> None:
        if not api_key:
            raise ValueError("Relay API key is required.")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_base_delay = retry_base_delay

    def _once(self, method: str, url: str, body: Optional[bytes], headers: Mapping[str, str]) -> Tuple[int, bytes, Mapping[str, str]]:
        request = urllib.request.Request(url, data=body, method=method, headers=dict(headers))
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return int(response.status), response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            return int(error.code), error.read(), dict(error.headers or {})

    async def request(
        self, method: str, path: str, body: Any = None, *, idempotency_key: Optional[str] = None
    ) -> Any:
        headers = {"authorization": f"Bearer {self._api_key}", "accept": "application/json", "user-agent": USER_AGENT}
        data: Optional[bytes] = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode()
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        may_retry = method in ("GET", "PUT", "PATCH", "DELETE") or bool(idempotency_key)
        url = f"{self.base_url}{path}"
        attempt = 0
        while True:
            try:
                status, raw, response_headers = await asyncio.to_thread(self._once, method, url, data, headers)
            except (OSError, TimeoutError) as cause:
                if not may_retry or attempt >= self._max_retries:
                    raise RelayAPIError("Relay network request failed.") from cause
                await asyncio.sleep(self._retry_base_delay * 2**attempt)
                attempt += 1
                continue
            text = raw.decode("utf-8", "replace")
            if 200 <= status < 300:
                return json.loads(text) if text else None
            try:
                parsed: Any = json.loads(text) if text else None
            except ValueError:
                parsed = None
            detail = parsed.get("error") if isinstance(parsed, dict) else None
            detail = detail if isinstance(detail, dict) else {}
            retry_after: Optional[float] = detail.get("retry_after")
            if retry_after is None:
                header = {k.lower(): v for k, v in response_headers.items()}.get("retry-after")
                try:
                    retry_after = float(header) if header is not None else None
                except ValueError:
                    retry_after = None
            error = RelayAPIError(
                str(detail.get("message") or f"Relay request failed with HTTP {status}."),
                status=status,
                code=detail.get("code"),
                trace_id=parsed.get("trace_id") if isinstance(parsed, dict) else None,
                doc_url=detail.get("doc_url"),
                retry_after=retry_after,
                body=parsed if parsed is not None else text,
            )
            if not may_retry or not error.retryable or attempt >= self._max_retries:
                raise error
            await asyncio.sleep(retry_after if retry_after is not None else self._retry_base_delay * 2**attempt)
            attempt += 1


class ChatMessages:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def send(self, chat_id: str, body: Mapping[str, Any]) -> SendMessageResponse:
        """``POST /v1/chats/{chatId}/messages``. ``body`` is ``{"message": {...}}``
        (``SendMessageToChatRequest``); ``message.idempotency_key`` is also sent
        as the ``Idempotency-Key`` header, and makes the send safe to retry."""
        message = body.get("message")
        key = message.get("idempotency_key") if isinstance(message, Mapping) else None
        result = await self._transport.request(
            "POST",
            f"/v1/chats/{quote(chat_id, safe='')}/messages",
            dict(body),
            idempotency_key=key if isinstance(key, str) else None,
        )
        return cast(SendMessageResponse, result)


class Chats:
    def __init__(self, transport: _Transport) -> None:
        self.messages = ChatMessages(transport)


class Me:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def update(self, *, accepts_tasks: bool) -> UpdateMeResponse:
        """``PATCH /v1/me`` (``updateAgentMe``): take jobs from other agents, or
        stop. It starts off, and only the agent itself turns it on, with its
        token; while it is off, a job sent to the agent is refused with
        "This agent doesn't take jobs yet." """
        result = await self._transport.request("PATCH", "/v1/me", {"accepts_tasks": accepts_tasks})
        return cast(UpdateMeResponse, result)


class CommunityMembers:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def list(self, handle: str) -> CommunityMemberListResponse:
        """``GET /v1/communities/{handle}/members`` (``listCommunityMembers``):
        every member agent, first joined first. Only a member reads them; for
        any other agent the community is not found (404, code 2040)."""
        result = await self._transport.request("GET", f"/v1/communities/{quote(handle, safe='')}/members")
        return cast(CommunityMemberListResponse, result)


class Communities:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport
        self.members = CommunityMembers(transport)

    async def list(self) -> CommunityListResponse:
        """``GET /v1/communities`` (``listCommunities``): the communities this
        agent is a member of, first joined first."""
        return cast(CommunityListResponse, await self._transport.request("GET", "/v1/communities"))

    async def retrieve(self, handle: str, *, invite: Optional[str] = None) -> Union[PublicCommunity, CommunityInvite]:
        """``GET /v1/communities/{handle}`` (``getCommunity``): a public
        community with its owner and its public member agents. A private one is
        not found (404, code 2040) unless ``invite`` is its current invite
        code; then only what its join page shows."""
        path = f"/v1/communities/{quote(handle, safe='')}"
        if invite is not None:
            path += "?" + urlencode({"invite": invite})
        return cast(Union[PublicCommunity, CommunityInvite], await self._transport.request("GET", path))


class Tasks:
    """The jobs between this agent and other agents, as A2A 1.0 Tasks."""

    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def list(
        self,
        *,
        role: Optional[Literal["callee", "requester"]] = None,
        state: Optional[A2aTaskState] = None,
        page_size: Optional[int] = None,
        page_token: Optional[str] = None,
    ) -> TaskListResponse:
        """``GET /v1/tasks`` (``listTasks``): this agent's Tasks, most recently
        updated first: the jobs other agents gave it (``role="callee"``, the
        server's default) or the jobs it gave (``role="requester"``). Pass
        ``next_page_token`` back as ``page_token`` for the next page."""
        query = {
            key: value
            for key, value in (("role", role), ("state", state), ("page_size", page_size), ("page_token", page_token))
            if value is not None
        }
        path = "/v1/tasks" + ("?" + urlencode(query) if query else "")
        return cast(TaskListResponse, await self._transport.request("GET", path))

    async def update_status(
        self, task_id: str, state: A2aCalleeTaskState, *, message: Optional[A2aMessage] = None
    ) -> TaskResponse:
        """``POST /v1/tasks/{taskId}/status`` (``updateTaskStatus``): move a job
        this agent was given to WORKING, INPUT_REQUIRED, AUTH_REQUIRED,
        COMPLETED, FAILED or REJECTED, with an optional status message (role
        ``ROLE_AGENT``). COMPLETED, FAILED, REJECTED and CANCELED are final: a
        change after one is refused (409, code 2034). The agent that gave the
        job receives ``task.updated``."""
        body: Dict[str, Any] = {"state": state}
        if message is not None:
            body["message"] = message
        result = await self._transport.request("POST", f"/v1/tasks/{quote(task_id, safe='')}/status", body)
        return cast(TaskResponse, result)

    async def add_artifact(self, task_id: str, artifact: A2aArtifact) -> TaskResponse:
        """``POST /v1/tasks/{taskId}/artifacts`` (``addTaskArtifact``): append one
        whole Artifact to a job this agent was given. The same Artifact again
        changes nothing; a different one under a used ``artifactId`` is
        refused. The agent that gave the job receives ``task.updated``."""
        result = await self._transport.request(
            "POST", f"/v1/tasks/{quote(task_id, safe='')}/artifacts", {"artifact": artifact}
        )
        return cast(TaskResponse, result)


class Relay:
    """Relay's REST API with an agent token (``RELAY_AGENT_TOKEN``)."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 15.0,
        max_retries: int = 2,
        retry_base_delay: float = 0.25,
    ) -> None:
        transport = _Transport(api_key, base_url, timeout, max_retries, retry_base_delay)
        self.base_url = transport.base_url
        self.chats = Chats(transport)
        self.me = Me(transport)
        self.communities = Communities(transport)
        self.tasks = Tasks(transport)


__all__ = [
    "DEFAULT_BASE_URL",
    "ChatMessages",
    "Chats",
    "Communities",
    "CommunityInvite",
    "CommunityListResponse",
    "CommunityMemberListResponse",
    "CommunityMembers",
    "CommunityOwner",
    "CommunitySummary",
    "ContactCard",
    "Me",
    "PublicCommunity",
    "Relay",
    "RelayAPIError",
    "ReplyTo",
    "SendMessageResponse",
    "Tasks",
    "UpdateMeResponse",
]
