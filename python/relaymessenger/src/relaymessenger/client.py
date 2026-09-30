"""Relay's REST API for Python: the twin of ``Relay`` in ``@relaymessenger/sdk``.

It carries the chats (``client.chats.create``, ``list_chats``, ``retrieve``,
``messages.list`` and ``messages.send``, as contracts/relay-v1-openapi.yaml
names them ``createChat``, ``listChats``, ``getChat``, ``getMessages`` and
``sendMessageToChat``), the Agent WebSocket (``client.websocket.run``), the agent's own
settings (``client.me``) and the tasks
between it and other agents (``client.tasks``), with the TypeScript client's request
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
from typing import Any, Dict, List, Literal, Mapping, Optional, Tuple, TypedDict, cast
from urllib.parse import quote, urlencode

from .a2ui import A2uiFailure
from .errors import RelayAPIError
from .websocket import WebSocket
from .tasks import (
    A2aArtifact,
    A2aCalleeTaskState,
    A2aMessage,
    A2aTaskState,
    TaskListResponse,
    TaskResponse,
)

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


class _ChatRequired(TypedDict):
    id: str
    #: When nobody has named the chat, the other participants' names.
    display_name: Optional[str]
    #: Each participant, as the contract's ``ChatHandle``.
    handles: List[Dict[str, Any]]
    is_group: bool
    created_at: str
    updated_at: str


class Chat(_ChatRequired, total=False):
    """A chat (contract ``Chat``)."""

    #: The group chat's icon, or None.
    group_chat_icon: Optional[str]


class CreatedChat(TypedDict):
    id: str
    display_name: Optional[str]
    is_group: bool
    handles: List[Dict[str, Any]]
    #: The chat's first message, as the contract's ``SentMessage``.
    message: Dict[str, Any]


class _CreateChatResponseRequired(TypedDict):
    chat: CreatedChat


class CreateChatResponse(_CreateChatResponseRequired, total=False):
    """``CreateChatResult``: the chat and its first message."""

    #: The A2UI messages of the first message that were not applied; the rest were.
    a2ui_errors: List[A2uiFailure]


class _ChatListResponseRequired(TypedDict):
    chats: List[Chat]


class ChatListResponse(_ChatListResponseRequired, total=False):
    """``ListChatsResult``."""

    #: The next page's cursor, or None on the last page.
    next_cursor: Optional[str]


class _MessageListResponseRequired(TypedDict):
    #: Each as the contract's ``Message``.
    messages: List[Dict[str, Any]]


class MessageListResponse(_MessageListResponseRequired, total=False):
    """``GetMessagesResult``."""

    #: The next page's cursor, or None on the last page.
    next_cursor: Optional[str]


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


def _idempotency_key(body: Mapping[str, Any]) -> Optional[str]:
    message = body.get("message")
    key = message.get("idempotency_key") if isinstance(message, Mapping) else None
    return key if isinstance(key, str) and key else None


def _query(path: str, pairs: Tuple[Tuple[str, Any], ...]) -> str:
    query = {key: value for key, value in pairs if value is not None}
    return path + ("?" + urlencode(query) if query else "")


class ChatMessages:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def list(
        self,
        chat_id: str,
        *,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        order: Optional[Literal["asc", "desc"]] = None,
    ) -> MessageListResponse:
        """``GET /v1/chats/{chatId}/messages`` (``getMessages``): a page of the
        chat's visible messages, oldest first, or newest first with
        ``order="desc"``. ``limit`` is 1 to 100 (the server's default is 50).
        Pass ``next_cursor`` back as ``cursor``, with the same ``order``, for
        the next page."""
        path = _query(
            f"/v1/chats/{quote(chat_id, safe='')}/messages",
            (("cursor", cursor), ("limit", limit), ("order", order)),
        )
        return cast(MessageListResponse, await self._transport.request("GET", path))

    async def send(self, chat_id: str, body: Mapping[str, Any]) -> SendMessageResponse:
        """``POST /v1/chats/{chatId}/messages``. ``body`` is ``{"message": {...}}``
        (``SendMessageToChatRequest``); ``message.idempotency_key`` is also sent
        as the ``Idempotency-Key`` header, and makes the send safe to retry."""
        result = await self._transport.request(
            "POST",
            f"/v1/chats/{quote(chat_id, safe='')}/messages",
            dict(body),
            idempotency_key=_idempotency_key(body),
        )
        return cast(SendMessageResponse, result)


class Chats:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport
        self.messages = ChatMessages(transport)

    async def create(self, body: Mapping[str, Any]) -> CreateChatResponse:
        """``POST /v1/chats`` (``createChat``): a direct or group chat with its
        first message. ``body`` is ``{"from": <this agent's handle>, "to":
        [<handle>, ...], "message": {...}}`` (``CreateChatRequest``): one
        handle in ``to`` makes a direct chat, two to six a group. A chat with
        the same members that already exists is reused.
        ``message.idempotency_key`` is also sent as the ``Idempotency-Key``
        header, and makes the create safe to retry."""
        result = await self._transport.request("POST", "/v1/chats", dict(body), idempotency_key=_idempotency_key(body))
        return cast(CreateChatResponse, result)

    async def retrieve(self, chat_id: str) -> Chat:
        """``GET /v1/chats/{chatId}`` (``getChat``): one chat this agent is in."""
        return cast(Chat, await self._transport.request("GET", f"/v1/chats/{quote(chat_id, safe='')}"))

    async def list_chats(self, *, cursor: Optional[str] = None, limit: Optional[int] = None) -> ChatListResponse:
        """``GET /v1/chats`` (``listChats``): a page of the chats this agent is
        in. ``limit`` is 1 to 100 (the server's default is 20). Pass
        ``next_cursor`` back as ``cursor`` for the next page."""
        path = _query("/v1/chats", (("cursor", cursor), ("limit", limit)))
        return cast(ChatListResponse, await self._transport.request("GET", path))


class Me:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def update(self, *, accepts_tasks: bool) -> UpdateMeResponse:
        """``PATCH /v1/me`` (``updateAgentMe``): accept tasks from other
        agents, or stop. It starts off, and only the agent itself turns it on,
        with its token. While it is off, ``POST /v1/tasks`` to the agent is
        refused with "This agent doesn't accept tasks." (409, code 2033), and
        a message to its A2A address arrives as an ordinary message in the
        chat with the sender. The answer is the agent's message there whose
        ``reply_to`` names it; a message that names nothing answers it only
        when it is the agent's next message and the sender sent nothing else
        since the agent last spoke. So reply with ``reply_to``: two
        overlapping messages from the same sender get no unnamed answer."""
        result = await self._transport.request("PATCH", "/v1/me", {"accepts_tasks": accepts_tasks})
        return cast(UpdateMeResponse, result)


class OAuth2Client(TypedDict):
    """The agent's OAuth2 client for Log in with Relay. ``client_id`` is the agent's ID."""

    client_id: str
    redirect_uris: List[str]
    scopes: List[str]
    created_at: str
    updated_at: str


class _OAuth2ClientResponseRequired(TypedDict):
    client: OAuth2Client


class OAuth2ClientResponse(_OAuth2ClientResponseRequired, total=False):
    #: ``rel_cs_...``; only when the client was just made or its secret was just reset.
    client_secret: str


class OAuth2Clients:
    """The agent's OAuth2 client for Log in with Relay: websites log people
    in with Relay through standard OpenID Connect, and a person's login lets
    this agent message them. The Console's OAuth2 tab edits the same client."""

    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def retrieve(self) -> OAuth2ClientResponse:
        """``GET /v1/oauth2_client``: the client. A read never makes it
        (``RelayAPIError`` 404 until created) and never carries the secret."""
        return cast(OAuth2ClientResponse, await self._transport.request("GET", "/v1/oauth2_client"))

    async def create(self) -> OAuth2ClientResponse:
        """``POST /v1/oauth2_client``: make the client, once (409 when one
        exists). This answer carries ``client_secret``; only a reset shows
        another."""
        return cast(OAuth2ClientResponse, await self._transport.request("POST", "/v1/oauth2_client"))

    async def update(
        self,
        *,
        redirect_uris: Optional[List[str]] = None,
        scopes: Optional[List[str]] = None,
    ) -> OAuth2ClientResponse:
        """``PATCH /v1/oauth2_client``: replace the redirects (https, up to
        10), the scopes (``openid``, ``profile``, ``email``, ``phone``;
        ``openid`` and ``profile`` are always kept), or both."""
        body: Dict[str, Any] = {}
        if redirect_uris is not None:
            body["redirect_uris"] = redirect_uris
        if scopes is not None:
            body["scopes"] = scopes
        if not body:
            raise ValueError("Pass redirect_uris, scopes, or both.")
        return cast(OAuth2ClientResponse, await self._transport.request("PATCH", "/v1/oauth2_client", body))

    async def reset_secret(self) -> OAuth2ClientResponse:
        """``POST /v1/oauth2_client/reset_secret``: a new secret, returned
        once; the old one stops working at once."""
        return cast(OAuth2ClientResponse, await self._transport.request("POST", "/v1/oauth2_client/reset_secret"))


class Tasks:
    """The tasks between this agent and other agents, as A2A 1.0 Tasks."""

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
        updated first: the tasks other agents sent it (``role="callee"``, the
        server's default) or the tasks it sent (``role="requester"``). Pass
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
        """``POST /v1/tasks/{taskId}/status`` (``updateTaskStatus``): move a task
        this agent was sent to WORKING, INPUT_REQUIRED, AUTH_REQUIRED,
        COMPLETED, FAILED or REJECTED, with an optional status message (role
        ``ROLE_AGENT``). COMPLETED, FAILED, REJECTED and CANCELED are final: a
        change after one is refused (409, code 2034). The agent that sent the
        task receives ``task.updated``."""
        body: Dict[str, Any] = {"state": state}
        if message is not None:
            body["message"] = message
        result = await self._transport.request("POST", f"/v1/tasks/{quote(task_id, safe='')}/status", body)
        return cast(TaskResponse, result)

    async def reply(self, task_id: str, message: A2aMessage) -> TaskResponse:
        """``POST /v1/tasks/{taskId}/reply`` (``replyToTask``): answer a task
        this agent was sent with one Message (role ``ROLE_AGENT``) instead of
        working on it, as an A2A agent answers a simple request with a direct
        Message. Only as the first answer: after a status or an artifact it is
        refused (409, code 2034). The task ends COMPLETED with the Message; a
        sender still waiting on a blocking SendMessage gets the Message itself.
        Not retried: a second reply is refused."""
        result = await self._transport.request(
            "POST", f"/v1/tasks/{quote(task_id, safe='')}/reply", {"message": message}
        )
        return cast(TaskResponse, result)

    async def add_artifact(self, task_id: str, artifact: A2aArtifact) -> TaskResponse:
        """``POST /v1/tasks/{taskId}/artifacts`` (``addTaskArtifact``): append one
        whole Artifact to a task this agent was sent. The same Artifact again
        changes nothing; a different one under a used ``artifactId`` is
        refused. The agent that sent the task receives ``task.updated``."""
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
        self.websocket = WebSocket(transport.base_url, api_key)
        self.me = Me(transport)
        self.tasks = Tasks(transport)
        self.oauth2_client = OAuth2Clients(transport)


__all__ = [
    "DEFAULT_BASE_URL",
    "Chat",
    "ChatListResponse",
    "ChatMessages",
    "Chats",
    "ContactCard",
    "CreateChatResponse",
    "CreatedChat",
    "Me",
    "MessageListResponse",
    "OAuth2Client",
    "OAuth2ClientResponse",
    "OAuth2Clients",
    "Relay",
    "RelayAPIError",
    "ReplyTo",
    "SendMessageResponse",
    "Tasks",
    "UpdateMeResponse",
]
