"""Relay's REST API for Python: the twin of ``Relay`` in ``@relaymessenger/sdk``.

It carries every operation an agent token may call in
contracts/relay-v1-openapi.yaml, under the
TypeScript client's resource names in Python style (``relay.chats.leave_chat``
is ``relay.chats.leaveChat``; ``relay.payment_requests`` is
``relay.paymentRequests``), the Agent WebSocket (``client.websocket.run``) and
webhook signature checks (``client.webhooks``), with the
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
from .parts import ReactionType
from .webhooks import Webhooks
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

    @property
    def api_key(self) -> str:
        return self._api_key

    def _put(self, url: str, data: bytes, headers: Mapping[str, str]) -> int:
        request = urllib.request.Request(url, data=data, method="PUT", headers=dict(headers))
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return int(response.status)
        except urllib.error.HTTPError as error:
            return int(error.code)

    async def upload(self, allocation: Mapping[str, Any], data: bytes) -> None:
        headers = dict(allocation.get("required_headers") or {})
        try:
            status = await asyncio.to_thread(self._put, str(allocation["upload_url"]), data, headers)
        except (OSError, TimeoutError) as cause:
            raise RelayAPIError("Relay attachment upload failed.") from cause
        if not 200 <= status < 300:
            raise RelayAPIError(f"Relay attachment upload failed with HTTP {status}.", status=status)

    async def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        idempotency_key: Optional[str] = None,
        retryable: bool = False,
        max_retries: Optional[int] = None,
    ) -> Any:
        headers = {"authorization": f"Bearer {self._api_key}", "accept": "application/json", "user-agent": USER_AGENT}
        data: Optional[bytes] = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode()
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        may_retry = retryable or method in ("GET", "PUT", "PATCH", "DELETE") or bool(idempotency_key)
        retries = self._max_retries if max_retries is None else max_retries
        url = f"{self.base_url}{path}"
        attempt = 0
        while True:
            try:
                status, raw, response_headers = await asyncio.to_thread(self._once, method, url, data, headers)
            except (OSError, TimeoutError) as cause:
                if not may_retry or attempt >= retries:
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
            if not may_retry or not error.retryable or attempt >= retries:
                raise error
            await asyncio.sleep(retry_after if retry_after is not None else self._retry_base_delay * 2**attempt)
            attempt += 1


def _idempotency_key(body: Mapping[str, Any]) -> Optional[str]:
    message = body.get("message")
    key = message.get("idempotency_key") if isinstance(message, Mapping) else None
    return key if isinstance(key, str) and key else None


_UNSET: Any = object()


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
        self.participants = ChatParticipants(transport)
        self.location = ChatLocation(transport)

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

    async def update(
        self, chat_id: str, *, display_name: Optional[str] = None, group_chat_icon: Any = _UNSET
    ) -> "ChatUpdateResponse":
        """``PUT /v1/chats/{chatId}`` (``updateChat``): rename a group chat,
        or set its icon (a URL; ``None`` removes it)."""
        body: Dict[str, Any] = {}
        if display_name is not None:
            body["display_name"] = display_name
        if group_chat_icon is not _UNSET:
            body["group_chat_icon"] = group_chat_icon
        if not body:
            raise ValueError("Pass display_name, group_chat_icon, or both.")
        return cast("ChatUpdateResponse", await self._transport.request("PUT", f"/v1/chats/{quote(chat_id, safe='')}", body))

    async def leave_chat(self, chat_id: str) -> "AcceptedResponse":
        """``POST /v1/chats/{chatId}/leave`` (``leaveChat``): leave a group chat."""
        return cast("AcceptedResponse", await self._transport.request("POST", f"/v1/chats/{quote(chat_id, safe='')}/leave"))

    async def start_typing(self, chat_id: str) -> None:
        """``POST /v1/chats/{chatId}/typing`` (``startTyping``); safe to retry."""
        await self._transport.request("POST", f"/v1/chats/{quote(chat_id, safe='')}/typing", retryable=True)

    async def stop_typing(self, chat_id: str) -> None:
        """``DELETE /v1/chats/{chatId}/typing`` (``stopTyping``)."""
        await self._transport.request("DELETE", f"/v1/chats/{quote(chat_id, safe='')}/typing", retryable=True)

    async def mark_as_read(self, chat_id: str) -> None:
        """``POST /v1/chats/{chatId}/read`` (``markChatAsRead``); safe to retry."""
        await self._transport.request("POST", f"/v1/chats/{quote(chat_id, safe='')}/read", retryable=True)

    async def get_activity(self, chat_id: str) -> "ChatActivityResponse":
        """``GET /v1/chats/{chatId}/activity`` (``getActivity``): this agent's
        status line in the chat."""
        return cast("ChatActivityResponse", await self._transport.request("GET", f"/v1/chats/{quote(chat_id, safe='')}/activity"))

    async def set_activity(
        self, chat_id: str, *, text: str, emoji: Any = _UNSET, activity_id: Optional[str] = None
    ) -> "ChatActivityResponse":
        """``PUT /v1/chats/{chatId}/activity`` (``setActivity``): show what
        this agent is doing; reuse ``activity_id`` to update one line."""
        body: Dict[str, Any] = {"text": text}
        if emoji is not _UNSET:
            body["emoji"] = emoji
        if activity_id is not None:
            body["activity_id"] = activity_id
        path = f"/v1/chats/{quote(chat_id, safe='')}/activity"
        return cast("ChatActivityResponse", await self._transport.request("PUT", path, body))

    async def clear_activity(self, chat_id: str, *, activity_id: Optional[str] = None) -> None:
        """``DELETE /v1/chats/{chatId}/activity`` (``clearActivity``); with
        ``activity_id``, only while that line is still the shown one."""
        path = _query(f"/v1/chats/{quote(chat_id, safe='')}/activity", (("activity_id", activity_id),))
        await self._transport.request("DELETE", path)

    async def send_voicememo(
        self, chat_id: str, *, attachment_id: Optional[str] = None, voice_memo_url: Optional[str] = None
    ) -> "ChatSendVoicememoResponse":
        """``POST /v1/chats/{chatId}/voicememo`` (``sendVoiceMemoToChat``):
        an uploaded ``attachment_id`` or a public ``voice_memo_url``, not both."""
        if (attachment_id is None) == (voice_memo_url is None):
            raise ValueError("send_voicememo takes attachment_id or voice_memo_url, exactly one.")
        body = {"attachment_id": attachment_id} if attachment_id is not None else {"voice_memo_url": voice_memo_url}
        path = f"/v1/chats/{quote(chat_id, safe='')}/voicememo"
        return cast("ChatSendVoicememoResponse", await self._transport.request("POST", path, body))

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



# ---------------------------------------------------------------------------
# The rest of Relay's REST API, as packages/sdk/src/client.ts names it, in
# Python style (``leaveChat`` is ``leave_chat``). Request bodies are keyword
# arguments; every answer is the contract's JSON as a typed dict.
# ---------------------------------------------------------------------------

PaymentCategory = Literal["physical_goods", "digital_goods", "donation"]
PaymentStatus = Literal["requested", "succeeded", "canceled", "expired"]
PaymentMode = Literal["payment", "subscription"]
AgentAccessRule = Literal["allow", "deny"]
AgentVisibility = Literal["public", "unlisted"]


class AcceptedResponse(TypedDict, total=False):
    status: str
    message: str
    trace_id: str


class ChatUpdateResponse(TypedDict, total=False):
    status: str
    chat_id: str


class ChatActivity(TypedDict):
    id: str
    text: str
    emoji: Optional[str]
    updated_at: str
    expires_at: str


class ChatActivityResponse(TypedDict):
    chat_id: str
    agent_id: str
    version: str
    activity: Optional[ChatActivity]


class LocationRequestResponse(TypedDict):
    success: Literal[True]
    message: str


class LocationFeature(TypedDict):
    """A GeoJSON point; ``geometry.coordinates`` is ``[longitude, latitude]``."""

    type: Literal["Feature"]
    geometry: Dict[str, Any]
    properties: Dict[str, Any]


class _FeatureCollection(TypedDict):
    type: Literal["FeatureCollection"]
    features: List[LocationFeature]


class GetChatLocationResponse(TypedDict):
    success: Literal[True]
    data: _FeatureCollection


class VoiceMemoAttachment(TypedDict, total=False):
    id: str
    url: str
    filename: str
    mime_type: str
    size_bytes: int
    duration_ms: Optional[int]
    width: Optional[int]
    height: Optional[int]


class ChatSendVoicememoResponse(TypedDict):
    #: ``id``, ``from``, ``to``, ``status``, ``voice_memo``, ``created_at`` and ``chat``.
    voice_memo: Dict[str, Any]


#: ``POST /v1/messages``'s answer: ``from`` (this agent's handle), the chat,
#: whether the send made it, and the ``SentMessage``.
MessageCreateResponse = TypedDict(
    "MessageCreateResponse",
    {
        "from": str,
        "chat_id": str,
        "created_new_chat": bool,
        "is_group": bool,
        "handles": List[ChatHandle],
        "message": Dict[str, Any],
    },
)


class PaymentDiscount(TypedDict, total=False):
    coupon: str
    promotion_code: str
    label: str


class PaymentRequest(TypedDict, total=False):
    """A payment request (contract ``PaymentRequest``)."""

    id: str
    object: Literal["payment_request"]
    status: PaymentStatus
    mode: PaymentMode
    amount: int
    application_fee_amount: int
    currency: str
    description: str
    category: PaymentCategory
    checkout_url: str
    expires_at: str
    metadata: Dict[str, str]
    image_url: str
    price_id: str
    quantity: int
    interval: Literal["day", "week", "month", "year"]
    interval_count: int
    discount: PaymentDiscount
    stripe: Dict[str, str]
    paid_at: str
    created_at: str
    updated_at: str


class PaymentRequestListResponse(TypedDict):
    payment_requests: List[PaymentRequest]
    next_cursor: Optional[str]


class AttachmentCreateResponse(TypedDict):
    attachment_id: str
    upload_url: str
    download_url: str
    http_method: Literal["PUT"]
    expires_at: str
    required_headers: Dict[str, str]


class Attachment(TypedDict, total=False):
    id: str
    filename: str
    content_type: str
    size_bytes: int
    status: Literal["pending", "complete", "failed"]
    download_url: str
    created_at: str
    duration_ms: Optional[int]
    width: Optional[int]
    height: Optional[int]


class WebhookEventListResponse(TypedDict):
    events: List[str]
    doc_url: str


class WebhookSubscription(TypedDict):
    id: str
    target_url: str
    subscribed_events: List[str]
    is_active: bool
    created_at: str
    updated_at: str


class WebhookSubscriptionCreateResponse(WebhookSubscription):
    #: ``whsec_...``: the key ``verify_webhook_signature`` checks deliveries with. Shown once.
    signing_secret: str


class WebhookSubscriptionListResponse(TypedDict):
    subscriptions: List[WebhookSubscription]


class ContactLookupResponse(TypedDict, total=False):
    """``{"contact": ...}`` for a handle or id, ``{"contacts": [...]}`` for a task."""

    contact: ContactCard
    contacts: List[ContactCard]


class ContactCardItem(TypedDict, total=False):
    id: str
    subtitle: Optional[str]
    url: str
    description: Optional[str]
    handle: Optional[str]
    first_name: str
    last_name: Optional[str]
    image_url: Optional[str]
    is_active: bool
    is_verified: bool
    links: List[str]
    about: Optional[str]
    kind: Literal["user", "agent"]


class ContactCardRetrieveResponse(TypedDict):
    contact_cards: List[ContactCardItem]


class SetContactCardResponse(TypedDict, total=False):
    description: Optional[str]
    first_name: str
    last_name: Optional[str]
    image_url: Optional[str]
    image_color: Optional[str]
    is_active: bool
    handle: str
    kind: Literal["user", "agent"]


class _BlockedHandleRequired(TypedDict):
    handle: str
    blocked_at: str


class BlockedHandle(_BlockedHandleRequired, total=False):
    reason: Optional[str]


class BlockedHandleListResponse(TypedDict):
    blocked_handles: List[BlockedHandle]


class BlockHandleResponse(TypedDict):
    blocked_handle: BlockedHandle


class AgentAccessLists(TypedDict):
    allow: List[ContactCard]
    deny: List[ContactCard]


class AgentAccessEntry(TypedDict):
    rule: AgentAccessRule
    contact: ContactCard


class AgentMe(TypedDict):
    """``GET /v1/me``: this agent. ``calls_enabled`` False means ``calls.create`` answers 503."""

    id: str
    handle: str
    kind: Literal["agent"]
    display_name: str
    owner: Optional[Dict[str, Any]]
    owner_people: List[OwnerPerson]
    calls_enabled: bool


CallStatus = Literal["ringing", "in-progress", "completed", "no-answer", "canceled", "busy", "failed"]

#: A call (contract ``Call``): ``from`` is the caller, ``to`` the one callee.
Call = TypedDict(
    "Call",
    {
        "id": str,
        "chat_id": str,
        "from": CallContact,
        "to": List[CallContact],
        "status": CallStatus,
        "revision": int,
        "created_at": str,
        "ringing_at": str,
        "answered_at": Optional[str],
        "ended_at": Optional[str],
    },
)


class CallResponse(TypedDict):
    call: Call


class CallListResponse(TypedDict):
    calls: List[Call]
    next_cursor: Optional[str]


def _path(value: str) -> str:
    return quote(value, safe="")


def _body(**fields: Any) -> Dict[str, Any]:
    """The fields that were passed: ``None`` means "not sent"."""
    return {key: value for key, value in fields.items() if value is not None}


class ChatParticipants:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def add(self, chat_id: str, *, handle: str, hide_history: Optional[bool] = None) -> AcceptedResponse:
        """``POST /v1/chats/{chatId}/participants`` (``addParticipant``)."""
        body = _body(handle=handle, hide_history=hide_history)
        return cast(AcceptedResponse, await self._transport.request("POST", f"/v1/chats/{_path(chat_id)}/participants", body))

    async def remove(self, chat_id: str, *, handle: str) -> AcceptedResponse:
        """``DELETE /v1/chats/{chatId}/participants`` (``removeParticipant``)."""
        return cast(
            AcceptedResponse,
            await self._transport.request("DELETE", f"/v1/chats/{_path(chat_id)}/participants", {"handle": handle}),
        )


class ChatLocation:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def request(self, chat_id: str) -> LocationRequestResponse:
        """``POST /v1/chats/{chatId}/location/request`` (``requestLocation``):
        ask the person to share their location."""
        return cast(LocationRequestResponse, await self._transport.request("POST", f"/v1/chats/{_path(chat_id)}/location/request"))

    async def retrieve(self, chat_id: str) -> GetChatLocationResponse:
        """``GET /v1/chats/{chatId}/location`` (``getLocation``): the live
        locations shared with this agent in the chat."""
        return cast(GetChatLocationResponse, await self._transport.request("GET", f"/v1/chats/{_path(chat_id)}/location"))


class Messages:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def create(
        self,
        *,
        to: List[str],
        message: Mapping[str, Any],
        idempotency_key: Optional[str] = None,
    ) -> MessageCreateResponse:
        """``POST /v1/messages`` (``sendMessage``): message handles, reusing
        their chat or making one. ``idempotency_key`` (else
        ``message.idempotency_key``) is sent as the ``Idempotency-Key`` header."""
        body = {"to": list(to), "message": dict(message)}
        key = idempotency_key or _idempotency_key(body)
        return cast(MessageCreateResponse, await self._transport.request("POST", "/v1/messages", body, idempotency_key=key))

    async def retrieve(self, message_id: str) -> Dict[str, Any]:
        """``GET /v1/messages/{messageId}`` (``getMessage``): one ``Message``."""
        return cast(Dict[str, Any], await self._transport.request("GET", f"/v1/messages/{_path(message_id)}"))

    async def add_reaction(
        self,
        message_id: str,
        *,
        operation: Literal["add", "remove"],
        type: ReactionType,
        custom_emoji: Optional[str] = None,
        part_index: Optional[int] = None,
    ) -> AcceptedResponse:
        """``POST /v1/messages/{messageId}/reactions`` (``sendReaction``): add
        or remove a reaction; ``custom_emoji`` with ``type="custom"``."""
        body = _body(operation=operation, type=type, custom_emoji=custom_emoji, part_index=part_index)
        return cast(AcceptedResponse, await self._transport.request("POST", f"/v1/messages/{_path(message_id)}/reactions", body))

    async def list_messages_thread(
        self,
        message_id: str,
        *,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        order: Optional[Literal["asc", "desc"]] = None,
    ) -> MessageListResponse:
        """``GET /v1/messages/{messageId}/thread`` (``getMessageThread``): a
        page of the replies to a message. Pass ``next_cursor`` back as ``cursor``."""
        path = _query(
            f"/v1/messages/{_path(message_id)}/thread",
            (("cursor", cursor), ("limit", limit), ("order", order)),
        )
        return cast(MessageListResponse, await self._transport.request("GET", path))


class PaymentRequests:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def create(
        self,
        *,
        description: str,
        category: PaymentCategory,
        amount: Optional[int] = None,
        currency: Optional[str] = None,
        metadata: Optional[Mapping[str, str]] = None,
        mode: Optional[PaymentMode] = None,
        price_id: Optional[str] = None,
        quantity: Optional[int] = None,
        customer_id: Optional[str] = None,
        discount: Optional[PaymentDiscount] = None,
        image_url: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> PaymentRequest:
        """``POST /v1/payment_requests`` (``createPaymentRequest``): a Stripe
        checkout to send as a ``payment`` part (``parts.payment_part``).
        ``amount`` is in the currency's smallest unit."""
        body = _body(
            amount=amount, currency=currency, description=description, category=category,
            metadata=dict(metadata) if metadata is not None else None, mode=mode, price_id=price_id,
            quantity=quantity, customer_id=customer_id, discount=discount, image_url=image_url,
        )
        result = await self._transport.request("POST", "/v1/payment_requests", body, idempotency_key=idempotency_key)
        return cast(PaymentRequest, result)

    async def list(
        self, *, cursor: Optional[str] = None, limit: Optional[int] = None, status: Optional[PaymentStatus] = None
    ) -> PaymentRequestListResponse:
        """``GET /v1/payment_requests`` (``listPaymentRequests``)."""
        path = _query("/v1/payment_requests", (("cursor", cursor), ("limit", limit), ("status", status)))
        return cast(PaymentRequestListResponse, await self._transport.request("GET", path))

    async def retrieve(self, payment_request_id: str) -> PaymentRequest:
        """``GET /v1/payment_requests/{paymentRequestId}`` (``getPaymentRequest``)."""
        return cast(PaymentRequest, await self._transport.request("GET", f"/v1/payment_requests/{_path(payment_request_id)}"))

    async def cancel(self, payment_request_id: str) -> PaymentRequest:
        """``POST /v1/payment_requests/{paymentRequestId}/cancel`` (``cancelPaymentRequest``)."""
        path = f"/v1/payment_requests/{_path(payment_request_id)}/cancel"
        return cast(PaymentRequest, await self._transport.request("POST", path, {}))


class Attachments:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def create(
        self,
        *,
        filename: str,
        content_type: str,
        size_bytes: int,
        duration_ms: Optional[int] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
    ) -> AttachmentCreateResponse:
        """``POST /v1/attachments`` (``requestUpload``): a presigned upload.
        Upload the bytes with ``upload``, then send ``attachment_id`` in a
        ``media`` part (``parts.media_part``)."""
        body = _body(
            filename=filename, content_type=content_type, size_bytes=size_bytes,
            duration_ms=duration_ms, width=width, height=height,
        )
        return cast(AttachmentCreateResponse, await self._transport.request("POST", "/v1/attachments", body))

    async def retrieve(self, attachment_id: str) -> Attachment:
        """``GET /v1/attachments/{attachmentId}`` (``getAttachment``)."""
        return cast(Attachment, await self._transport.request("GET", f"/v1/attachments/{_path(attachment_id)}"))

    async def delete(self, attachment_id: str) -> None:
        """``DELETE /v1/attachments/{attachmentId}`` (``deleteAttachment``)."""
        await self._transport.request("DELETE", f"/v1/attachments/{_path(attachment_id)}")

    async def upload(self, allocation: AttachmentCreateResponse, data: bytes) -> None:
        """PUT ``data`` to the allocation's ``upload_url`` with its
        ``required_headers`` and no Relay token, as the TypeScript SDK does."""
        await self._transport.upload(allocation, data)


class WebhookEvents:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def list(self) -> WebhookEventListResponse:
        """``GET /v1/webhook-events`` (``listWebhookEvents``): every event type."""
        return cast(WebhookEventListResponse, await self._transport.request("GET", "/v1/webhook-events"))


class WebhookSubscriptions:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def create(self, *, target_url: str, subscribed_events: List[str]) -> WebhookSubscriptionCreateResponse:
        """``POST /v1/webhook-subscriptions``: answers ``signing_secret`` once."""
        body = {"target_url": target_url, "subscribed_events": list(subscribed_events)}
        return cast(WebhookSubscriptionCreateResponse, await self._transport.request("POST", "/v1/webhook-subscriptions", body))

    async def retrieve(self, subscription_id: str) -> WebhookSubscription:
        path = f"/v1/webhook-subscriptions/{_path(subscription_id)}"
        return cast(WebhookSubscription, await self._transport.request("GET", path))

    async def update(
        self,
        subscription_id: str,
        *,
        target_url: Optional[str] = None,
        subscribed_events: Optional[List[str]] = None,
        is_active: Optional[bool] = None,
    ) -> WebhookSubscription:
        """``PUT /v1/webhook-subscriptions/{id}``: only the fields passed change."""
        body = _body(target_url=target_url, subscribed_events=subscribed_events, is_active=is_active)
        path = f"/v1/webhook-subscriptions/{_path(subscription_id)}"
        return cast(WebhookSubscription, await self._transport.request("PUT", path, body))

    async def list(self) -> WebhookSubscriptionListResponse:
        return cast(WebhookSubscriptionListResponse, await self._transport.request("GET", "/v1/webhook-subscriptions"))

    async def delete(self, subscription_id: str) -> None:
        await self._transport.request("DELETE", f"/v1/webhook-subscriptions/{_path(subscription_id)}")


class Contacts:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def lookup(
        self, *, handle: Optional[str] = None, id: Optional[str] = None, task: Optional[str] = None
    ) -> ContactLookupResponse:
        """``POST /v1/contacts/lookup`` (``lookupContact``): one contact by
        ``handle`` or ``id``, or the public agents that match a ``task``.
        Pass exactly one."""
        body = _body(handle=handle, id=id, task=task)
        if len(body) != 1:
            raise ValueError("lookup takes handle, id or task, exactly one.")
        return cast(ContactLookupResponse, await self._transport.request("POST", "/v1/contacts/lookup", body))

class ContactCards:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def create(
        self,
        *,
        handle: str,
        first_name: str,
        last_name: Optional[str] = None,
        image_url: Optional[str] = None,
        attachment_id: Optional[str] = None,
        image_recipe: Optional[Mapping[str, Any]] = None,
    ) -> SetContactCardResponse:
        """``POST /v1/contact_card`` (``setupContactCard``)."""
        body = _body(
            handle=handle, first_name=first_name, last_name=last_name, image_url=image_url,
            attachment_id=attachment_id, image_recipe=dict(image_recipe) if image_recipe is not None else None,
        )
        return cast(SetContactCardResponse, await self._transport.request("POST", "/v1/contact_card", body))

    async def retrieve(self, *, handle: Optional[str] = None) -> ContactCardRetrieveResponse:
        """``GET /v1/contact_card`` (``getContactCard``)."""
        path = _query("/v1/contact_card", (("handle", handle),))
        return cast(ContactCardRetrieveResponse, await self._transport.request("GET", path))

    async def update(self, handle: str, **fields: Any) -> SetContactCardResponse:
        """``PATCH /v1/contact_card?handle=`` (``updateContactCard``): send
        any of ``description``, ``subtitle``, ``first_name``, ``last_name``,
        ``image_url``, ``attachment_id`` and ``image_recipe``; ``None`` clears
        a nullable field."""
        allowed = {"description", "subtitle", "first_name", "last_name", "image_url", "attachment_id", "image_recipe"}
        unknown = sorted(set(fields) - allowed)
        if unknown:
            raise TypeError(f"update got unknown fields: {', '.join(unknown)}")
        path = _query("/v1/contact_card", (("handle", handle),))
        return cast(SetContactCardResponse, await self._transport.request("PATCH", path, fields))


class BlockedHandles:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def list(self) -> BlockedHandleListResponse:
        """``GET /v1/blocked_handles`` (``listBlockedHandles``)."""
        return cast(BlockedHandleListResponse, await self._transport.request("GET", "/v1/blocked_handles"))

    async def block(self, *, handle: str, reason: Optional[str] = None) -> BlockHandleResponse:
        """``POST /v1/blocked_handles`` (``blockHandle``)."""
        body = _body(handle=handle, reason=reason)
        return cast(BlockHandleResponse, await self._transport.request("POST", "/v1/blocked_handles", body))

    async def unblock(self, *, handle: str) -> None:
        """``DELETE /v1/blocked_handles`` (``unblockHandle``)."""
        await self._transport.request("DELETE", "/v1/blocked_handles", {"handle": handle})


class Access:
    """Who can message this agent: its allow and deny lists."""

    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def list(self) -> AgentAccessLists:
        """``GET /v1/access`` (``listAgentAccess``)."""
        return cast(AgentAccessLists, await self._transport.request("GET", "/v1/access"))

    async def set(self, handle: str, *, rule: AgentAccessRule) -> AgentAccessEntry:
        """``PUT /v1/access/{handle}`` (``setAgentAccess``)."""
        return cast(AgentAccessEntry, await self._transport.request("PUT", f"/v1/access/{_path(handle)}", {"rule": rule}))

    async def remove(self, handle: str) -> None:
        """``DELETE /v1/access/{handle}`` (``removeAgentAccess``)."""
        await self._transport.request("DELETE", f"/v1/access/{_path(handle)}")


class Agents:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def delete(self, handle: str) -> None:
        """``DELETE /v1/agents/{handle}`` (``deleteAgent``). Never retried,
        as in the TypeScript SDK: a delete is not undone."""
        await self._transport.request("DELETE", f"/v1/agents/{_path(handle)}", max_retries=0)


class Calls:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def create(self, chat_id: str, *, to: List[str], idempotency_key: str) -> CallResponse:
        """``POST /v1/chats/{chatId}/calls`` (``createCall``): ring one
        handle. ``idempotency_key`` (1 to 255 characters) is required, so a
        retry never rings twice."""
        if not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 255:
            raise ValueError("Call creation requires an idempotency_key of 1 to 255 characters.")
        path = f"/v1/chats/{_path(chat_id)}/calls"
        return cast(CallResponse, await self._transport.request("POST", path, {"to": list(to)}, idempotency_key=idempotency_key))

    async def retrieve(self, call_id: str) -> CallResponse:
        """``GET /v1/calls/{callId}`` (``getCall``)."""
        return cast(CallResponse, await self._transport.request("GET", f"/v1/calls/{_path(call_id)}"))

    async def list(self, chat_id: str, *, cursor: Optional[str] = None, limit: Optional[int] = None) -> CallListResponse:
        """``GET /v1/chats/{chatId}/calls`` (``listCalls``)."""
        path = _query(f"/v1/chats/{_path(chat_id)}/calls", (("cursor", cursor), ("limit", limit)))
        return cast(CallListResponse, await self._transport.request("GET", path))

    async def end(self, call_id: str) -> CallResponse:
        """``POST /v1/calls/{callId}/end`` (``endCall``); safe to retry."""
        path = f"/v1/calls/{_path(call_id)}/end"
        return cast(CallResponse, await self._transport.request("POST", path, {}, retryable=True))

    def room(self, call_id: str, **options: Any) -> Any:
        """The call's signaling room, ``relaymessenger.calls.CallRoom``; needs
        the ``calls`` extra."""
        from .calls.room import CallRoom

        return CallRoom(call_id, api_key=self._transport.api_key, base_url=self._transport.base_url, **options)


class Me:
    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def retrieve(self) -> AgentMe:
        """``GET /v1/me`` (``getMe``): this agent."""
        return cast(AgentMe, await self._transport.request("GET", "/v1/me"))


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
        webhook_secret: Optional[str] = None,
    ) -> None:
        transport = _Transport(api_key, base_url, timeout, max_retries, retry_base_delay)
        self.base_url = transport.base_url
        self.access = Access(transport)
        self.agents = Agents(transport)
        self.attachments = Attachments(transport)
        self.blocked_handles = BlockedHandles(transport)
        self.calls = Calls(transport)
        self.chats = Chats(transport)
        self.contact_card = ContactCards(transport)
        self.contacts = Contacts(transport)
        self.directory = Directory(transport)
        self.me = Me(transport)
        self.messages = Messages(transport)
        self.oauth2_client = OAuth2Clients(transport)
        self.payment_requests = PaymentRequests(transport)
        self.webhook_events = WebhookEvents(transport)
        self.webhook_subscriptions = WebhookSubscriptions(transport)
        self.webhooks = Webhooks(webhook_secret)
        self.websocket = WebSocket(transport.base_url, api_key)


__all__ = [
    "DEFAULT_BASE_URL",
    "AcceptedResponse",
    "Access",
    "AgentAccessEntry",
    "AgentAccessLists",
    "AgentAccessRule",
    "AgentMe",
    "AgentVisibility",
    "Agents",
    "Attachment",
    "AttachmentCreateResponse",
    "Attachments",
    "BlockHandleResponse",
    "BlockedHandle",
    "BlockedHandleListResponse",
    "BlockedHandles",
    "Call",
    "CallListResponse",
    "CallResponse",
    "CallStatus",
    "Calls",
    "ChatActivity",
    "ChatActivityResponse",
    "ChatLocation",
    "ChatParticipants",
    "ChatSendVoicememoResponse",
    "ChatUpdateResponse",
    "ContactCardItem",
    "ContactCardRetrieveResponse",
    "ContactCards",
    "ContactLookupResponse",
    "Contacts",
    "GetChatLocationResponse",
    "LocationFeature",
    "LocationRequestResponse",
    "Me",
    "MessageCreateResponse",
    "Messages",
    "PaymentCategory",
    "PaymentDiscount",
    "PaymentMode",
    "PaymentRequest",
    "PaymentRequestListResponse",
    "PaymentRequests",
    "PaymentStatus",
    "ReactionType",
    "SetContactCardResponse",
    "VoiceMemoAttachment",
    "WebhookEventListResponse",
    "WebhookEvents",
    "WebhookSubscription",
    "WebhookSubscriptionCreateResponse",
    "WebhookSubscriptionListResponse",
    "WebhookSubscriptions",
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
