"""Relay's REST API for Python: the twin of ``Relay`` in ``@relaymessenger/sdk``.

It carries the chats (``client.chats.create``, ``list_chats``, ``retrieve``,
``messages.list`` and ``messages.send``, as contracts/relay-v1-openapi.yaml
names them ``createChat``, ``listChats``, ``getChat``, ``getMessages`` and
``sendMessageToChat``) and the Agent WebSocket (``client.websocket.run``), with the
TypeScript client's request rules: bearer token, 15 s timeout, and up to two retries with
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

from .errors import RelayAPIError
from .websocket import WebSocket

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
    message: Dict[str, Any]


#: A person's age range: the bands Apple's Declared Age Range answers for the
#: age gates 13, 16 and 18.
AgeRange = Literal["under_13", "13_15", "16_17", "18_plus"]
#: Who an agent is for; Relay refuses an 18_plus agent (error 2035) to every
#: person whose age range is not 18_plus.
AgentAgeRating = Literal["everyone", "18_plus"]


class ChatHandle(TypedDict, total=False):
    """A chat participant (contract ``ChatHandle``). ``owner`` is an agent's
    own field; ``timezone`` a person's."""

    id: str
    handle: str
    status: Optional[Literal["active", "left", "removed"]]
    joined_at: str
    left_at: Optional[str]
    is_me: Optional[bool]
    kind: Literal["user", "agent"]
    display_name: Optional[str]
    image_url: Optional[str]
    image_color: Optional[str]
    subtitle: Optional[str]
    verified: bool
    owner: Optional[Dict[str, Any]]
    #: The person's IANA time zone name ("America/Detroit"), as their Relay
    #: app last reported it; None until it reports one. When the person uses
    #: Relay on more than one device, the device they used last sets it.
    #: Timestamps stay in UTC; use this to read them in the person's local time.
    timezone: Optional[str]
    #: The person's age range ("under_13", "13_15", "16_17" or "18_plus"),
    #: as their Relay app last reported it from Apple's Declared Age Range or
    #: a birth year given once; None until it reports one. A person whose
    #: range is not "18_plus" never reaches an agent rated 18_plus.
    age_range: Optional[AgeRange]
    #: The person's profile links: at most 5 absolute https URLs, in the order
    #: they chose, as Relay normalised them; empty when they set none. Relay
    #: sends no platform name; read the site from the URL.
    links: List[str]
    #: The person's about, as they wrote it in Relay: plain text, at most 160
    #: characters; None when they wrote none.
    about: Optional[str]
    is_contact: bool
    activity_version: str
    activity: Optional[Dict[str, Any]]


class ContactEventContact(TypedDict):
    """The person in ``contact.added`` and ``contact.removed``."""

    id: str
    handle: str
    display_name: str
    #: The person's IANA time zone name, or None until their app reports one.
    timezone: Optional[str]
    #: The person's age range ("under_13", "13_15", "16_17" or "18_plus"),
    #: as their Relay app last reported it from Apple's Declared Age Range or
    #: a birth year given once; None until it reports one. A person whose
    #: range is not "18_plus" never reaches an agent rated 18_plus.
    age_range: Optional[AgeRange]
    #: The person's profile links: at most 5 absolute https URLs, in the order
    #: they chose, as Relay normalised them; empty when they set none. Relay
    #: sends no platform name; read the site from the URL.
    links: List[str]
    #: The person's about, as they wrote it in Relay: plain text, at most 160
    #: characters; None when they wrote none.
    about: Optional[str]


class _PartyRequired(TypedDict):
    id: str
    handle: str
    kind: Literal["user", "agent"]


class CallContact(_PartyRequired, total=False):
    """A call's caller or callee (contract ``CallContact``); ``timezone`` only for a person."""

    #: The person's IANA time zone name ("America/Detroit"), as their Relay
    #: app last reported it; None until it reports one. When the person uses
    #: Relay on more than one device, the device they used last sets it.
    timezone: Optional[str]
    #: The person's age range ("under_13", "13_15", "16_17" or "18_plus"),
    #: as their Relay app last reported it from Apple's Declared Age Range or
    #: a birth year given once; None until it reports one. A person whose
    #: range is not "18_plus" never reaches an agent rated 18_plus.
    age_range: Optional[AgeRange]
    #: The person's profile links: at most 5 absolute https URLs, in the order
    #: they chose, as Relay normalised them; empty when they set none. Relay
    #: sends no platform name; read the site from the URL.
    links: List[str]
    #: The person's about, as they wrote it in Relay: plain text, at most 160
    #: characters; None when they wrote none.
    about: Optional[str]


class SystemEventParty(_PartyRequired, total=False):
    """A system event's actor or subject (contract ``SystemEventParty``); ``timezone`` only for a person."""

    #: The person's IANA time zone name ("America/Detroit"), as their Relay
    #: app last reported it; None until it reports one. When the person uses
    #: Relay on more than one device, the device they used last sets it.
    timezone: Optional[str]
    #: The person's age range ("under_13", "13_15", "16_17" or "18_plus"),
    #: as their Relay app last reported it from Apple's Declared Age Range or
    #: a birth year given once; None until it reports one. A person whose
    #: range is not "18_plus" never reaches an agent rated 18_plus.
    age_range: Optional[AgeRange]
    #: The person's profile links: at most 5 absolute https URLs, in the order
    #: they chose, as Relay normalised them; empty when they set none. Relay
    #: sends no platform name; read the site from the URL.
    links: List[str]
    #: The person's about, as they wrote it in Relay: plain text, at most 160
    #: characters; None when they wrote none.
    about: Optional[str]


class _UserOwnerRequired(TypedDict):
    kind: Literal["user"]
    handle: Optional[str]
    display_name: Optional[str]


class UserOwner(_UserOwnerRequired, total=False):
    """The person who owns an agent (contract ``UserOwner``); every field is None
    when the person has no Relay account."""

    #: The person's IANA time zone name ("America/Detroit"), as their Relay
    #: app last reported it; None until it reports one. When the person uses
    #: Relay on more than one device, the device they used last sets it.
    timezone: Optional[str]
    #: The person's age range ("under_13", "13_15", "16_17" or "18_plus"),
    #: as their Relay app last reported it from Apple's Declared Age Range or
    #: a birth year given once; None until it reports one. A person whose
    #: range is not "18_plus" never reaches an agent rated 18_plus.
    age_range: Optional[AgeRange]
    #: The person's profile links: at most 5 absolute https URLs, in the order
    #: they chose, as Relay normalised them; empty when they set none. Relay
    #: sends no platform name; read the site from the URL.
    #: None when the person has no Relay account.
    links: Optional[List[str]]
    #: The person's about, as they wrote it in Relay: plain text, at most 160
    #: characters; None when they wrote none.
    about: Optional[str]


class _OwnerPersonRequired(TypedDict):
    id: str
    handle: str
    display_name: str


class OwnerPerson(_OwnerPersonRequired, total=False):
    """A person who administers an agent (contract ``OwnerPerson``)."""

    #: The person's IANA time zone name ("America/Detroit"), as their Relay
    #: app last reported it; None until it reports one. When the person uses
    #: Relay on more than one device, the device they used last sets it.
    timezone: Optional[str]
    #: The person's age range ("under_13", "13_15", "16_17" or "18_plus"),
    #: as their Relay app last reported it from Apple's Declared Age Range or
    #: a birth year given once; None until it reports one. A person whose
    #: range is not "18_plus" never reaches an agent rated 18_plus.
    age_range: Optional[AgeRange]
    #: The person's profile links: at most 5 absolute https URLs, in the order
    #: they chose, as Relay normalised them; empty when they set none. Relay
    #: sends no platform name; read the site from the URL.
    links: List[str]
    #: The person's about, as they wrote it in Relay: plain text, at most 160
    #: characters; None when they wrote none.
    about: Optional[str]


class _ChatRequired(TypedDict):
    id: str
    #: When nobody has named the chat, the other participants' names.
    display_name: Optional[str]
    #: Each participant.
    handles: List[ChatHandle]
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
    handles: List[ChatHandle]
    #: The chat's first message, as the contract's ``SentMessage``.
    message: Dict[str, Any]


class _CreateChatResponseRequired(TypedDict):
    chat: CreatedChat


class CreateChatResponse(_CreateChatResponseRequired, total=False):
    """``CreateChatResult``: the chat and its first message."""


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


AgentCategory = Literal[
    "productivity", "business", "finance", "shopping", "travel", "health-fitness",
    "lifestyle", "social", "education", "entertainment", "utilities", "developer-tools",
]


class AgentMetrics(TypedDict):
    chats_people: int
    chats_agents: int
    chats_people_30d: int
    chats_agents_30d: int
    reply_rate_30d: Optional[float]
    reply_minutes_30d: Optional[float]
    messages_total: int
    since: str


class AgentRatingAverage(TypedDict):
    average: Optional[float]
    count: int


class DirectoryProvider(TypedDict):
    name: Optional[str]
    url: Optional[str]
    verified: bool


class DirectoryAgent(TypedDict):
    handle: str
    name: str
    subtitle: Optional[str]
    category: AgentCategory
    image_url: Optional[str]
    image_color: Optional[str]
    accent_color: Optional[str]
    verified: bool
    provider: DirectoryProvider
    metrics: AgentMetrics
    rating: AgentRatingAverage


class DirectorySearchResponse(TypedDict):
    agents: List[DirectoryAgent]


class ContactCard(TypedDict, total=False):
    """``ContactLookup``: a contact's Card. ``name``, ``subtitle``,
    ``description``, ``category``, ``skills``, ``visibility`` and ``creator``
    are the agent's own fields; ``timezone`` is a person's."""

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
    #: Who the agent is for: "everyone", or "18_plus" (only people whose age
    #: range is 18_plus reach it).
    age_rating: AgentAgeRating
    creator: Optional[Dict[str, Any]]
    can_message: bool
    #: The person's IANA time zone name, or None until their app reports one.
    timezone: Optional[str]
    #: The person's age range ("under_13", "13_15", "16_17" or "18_plus"),
    #: as their Relay app last reported it from Apple's Declared Age Range or
    #: a birth year given once; None until it reports one. A person whose
    #: range is not "18_plus" never reaches an agent rated 18_plus.
    age_range: Optional[AgeRange]
    #: The person's profile links: at most 5 absolute https URLs, in the order
    #: they chose, as Relay normalised them; empty when they set none. Relay
    #: sends no platform name; read the site from the URL.
    links: List[str]
    #: The person's about, as they wrote it in Relay: plain text, at most 160
    #: characters; None when they wrote none.
    about: Optional[str]


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


class Directory:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def search(
        self,
        *,
        q: Optional[str] = None,
        category: Optional[AgentCategory] = None,
        limit: Optional[int] = None,
        sort: Optional[Literal["name", "newest"]] = None,
    ) -> DirectorySearchResponse:
        """Search ``GET /v1/directory`` with only the supplied filters."""
        path = _query("/v1/directory", (("q", q), ("category", category), ("limit", limit), ("sort", sort)))
        return cast(DirectorySearchResponse, await self._transport.request("GET", path))


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

    async def share_contact_card(
        self,
        chat_id: str,
        *,
        handle: Optional[str] = None,
        user_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> None:
        """Share a contact card into a chat.

        Omitting ``handle`` and ``user_id`` shares the caller's own card. With
        ``handle``, it recommends an agent that is Public or Unlisted and that
        people can message; the card is a snapshot of that agent at send time.
        With ``user_id``, it shares a person who has sent a message in a chat
        with you and has not blocked you, into a chat with an active person
        none of whom has blocked or been blocked by them; anything else is the
        same 404. Ask both people first. The card is a snapshot of their id,
        handle, name, photo, links and about. Send ``handle`` or ``user_id``, not
        both. The same ``idempotency_key`` and body replay with nothing shared.
        """
        if handle is not None and user_id is not None:
            raise ValueError("share_contact_card takes handle or user_id, not both")
        body: Optional[Dict[str, str]] = (
            {"handle": handle} if handle is not None else {"user_id": user_id} if user_id is not None else None
        )
        await self._transport.request(
            "POST",
            f"/v1/chats/{quote(chat_id, safe='')}/share_contact_card",
            body,
            idempotency_key=idempotency_key,
        )


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
        10), the scopes (``openid``, ``profile``, ``email``, ``phone``, ``birthdate``;
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
        self.directory = Directory(transport)
        self.websocket = WebSocket(transport.base_url, api_key)
        self.oauth2_client = OAuth2Clients(transport)


__all__ = [
    "DEFAULT_BASE_URL",
    "AgentCategory",
    "AgentMetrics",
    "AgentRatingAverage",
    "Directory",
    "DirectoryAgent",
    "DirectoryProvider",
    "DirectorySearchResponse",
    "Chat",
    "ChatListResponse",
    "ChatMessages",
    "Chats",
    "ContactCard",
    "CreateChatResponse",
    "CreatedChat",
    "MessageListResponse",
    "OAuth2Client",
    "OAuth2ClientResponse",
    "OAuth2Clients",
    "Relay",
    "RelayAPIError",
    "ReplyTo",
    "SendMessageResponse",
]
