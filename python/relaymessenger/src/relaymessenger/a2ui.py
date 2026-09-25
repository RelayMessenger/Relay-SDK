"""A2UI v0.9.1 cards in Relay messages: build them, send them, read their taps.

A card is A2A's DataPart holding A2UI messages (https://a2ui.org):
``{"type": "data", "media_type": "application/a2ui+json", "data": [...]}``
(``DataPart`` in contracts/relay-v1-openapi.yaml). The message types copy
A2UI v0.9.1's ``server_to_client.json`` (createSurface, updateComponents,
updateDataModel, deleteSurface) and ``client_to_server.json`` (action, error)
field for field, in A2UI's own camelCase, so a card written for any A2UI
renderer is sent unchanged. Components belong to the catalog named by
``createSurface.catalogId``; Relay keeps unknown ones and delivers them as sent,
so they are plain dicts here.

Relay applies every A2UI message of a send in order. The ones it did not apply
come back in the response's ``a2ui_errors``; a send that applied nothing raises
:class:`~relaymessenger.client.RelayAPIError` with ``a2ui_errors`` set.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, Final, List, Literal, Mapping, Optional, Sequence, TypedDict, Union, cast

if TYPE_CHECKING:
    from .client import Relay, ReplyTo, SendMessageResponse

#: ``DataPart.media_type``; any other value is refused with 422.
A2UI_MEDIA_TYPE: Final = "application/a2ui+json"
#: The A2UI version every message this module builds carries.
A2UI_VERSION: Final = "v0.9.1"
#: Relay's catalog: every basic catalog component and function, plus ``PaymentRequest``.
RELAY_A2UI_CATALOG_ID: Final = "https://relayapp.im/a2ui/catalog/v1"
#: A2UI v0.9.1's basic catalog.
A2UI_BASIC_CATALOG_ID: Final = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"

A2uiVersion = Literal["v0.9", "v0.9.1"]
#: A component of the surface's catalog, for example
#: ``{"id": "root", "component": "Text", "text": "Hello"}``. One component of a
#: surface must have the id ``root``.
A2uiComponent = Dict[str, Any]


# Server to client (the agent draws) ------------------------------------------


class _A2uiCreateSurfaceRequired(TypedDict):
    surfaceId: str
    catalogId: str


class A2uiCreateSurface(_A2uiCreateSurfaceRequired, total=False):
    theme: Dict[str, Any]
    #: The app sends the surface's whole data model with every tap on it.
    sendDataModel: bool


class A2uiCreateSurfaceMessage(TypedDict):
    version: A2uiVersion
    createSurface: A2uiCreateSurface


class A2uiUpdateComponents(TypedDict):
    surfaceId: str
    components: List[A2uiComponent]


class A2uiUpdateComponentsMessage(TypedDict):
    version: A2uiVersion
    updateComponents: A2uiUpdateComponents


class _A2uiUpdateDataModelRequired(TypedDict):
    surfaceId: str


class A2uiUpdateDataModel(_A2uiUpdateDataModelRequired, total=False):
    #: A JSON Pointer into the data model; omitted or ``/`` is the whole model.
    path: str
    #: Replaces the value at ``path``; omitted removes the key at ``path``.
    value: Any


class A2uiUpdateDataModelMessage(TypedDict):
    version: A2uiVersion
    updateDataModel: A2uiUpdateDataModel


class A2uiDeleteSurface(TypedDict):
    surfaceId: str


class A2uiDeleteSurfaceMessage(TypedDict):
    version: A2uiVersion
    deleteSurface: A2uiDeleteSurface


A2uiServerMessage = Union[
    A2uiCreateSurfaceMessage,
    A2uiUpdateComponentsMessage,
    A2uiUpdateDataModelMessage,
    A2uiDeleteSurfaceMessage,
]


# Client to server (a tap, or a renderer's error) -----------------------------


class A2uiAction(TypedDict):
    #: The tapped Button's ``action.event.name``.
    name: str
    surfaceId: str
    #: The tapped Button's component id.
    sourceComponentId: str
    #: ISO 8601.
    timestamp: str
    #: The Button's ``action.event.context``, with its data bindings resolved.
    context: Dict[str, Any]


class A2uiActionMessage(TypedDict):
    version: A2uiVersion
    action: A2uiAction


class _A2uiErrorRequired(TypedDict):
    #: ``VALIDATION_FAILED``, or a renderer's own code.
    code: str
    surfaceId: str
    message: str


class A2uiError(_A2uiErrorRequired, total=False):
    #: A JSON Pointer to the failing field; always present for ``VALIDATION_FAILED``.
    path: str


class A2uiErrorMessage(TypedDict):
    version: A2uiVersion
    error: A2uiError


A2uiClientMessage = Union[A2uiActionMessage, A2uiErrorMessage]
A2uiMessage = Union[A2uiServerMessage, A2uiClientMessage]


class A2uiDataPart(TypedDict):
    type: Literal["data"]
    media_type: Literal["application/a2ui+json"]
    #: A2UI messages, in order. Read back, a card's part holds every message
    #: accepted for its surfaces since, so replaying the list draws the card.
    data: List[A2uiMessage]


# Handshake metadata on every message.received --------------------------------


class A2uiCatalogs(TypedDict):
    supportedCatalogIds: List[str]


#: ``metadata.a2uiClientCapabilities``: the catalogs the reader's app draws, in
#: order of preference. Its key is the protocol family ``v0.9``.
A2uiClientCapabilities = TypedDict("A2uiClientCapabilities", {"v0.9": A2uiCatalogs})


class A2uiClientDataModel(TypedDict):
    version: A2uiVersion
    #: Each ``sendDataModel`` surface's data model, by surfaceId.
    surfaces: Dict[str, Dict[str, Any]]


# Builders ---------------------------------------------------------------------

_OMIT: Any = object()


def create_surface(
    surface_id: str,
    *,
    catalog_id: str = RELAY_A2UI_CATALOG_ID,
    theme: Optional[Mapping[str, Any]] = None,
    send_data_model: Optional[bool] = None,
) -> A2uiCreateSurfaceMessage:
    """``createSurface``. A surfaceId already live in the chat fails with 409."""
    surface: A2uiCreateSurface = {"surfaceId": surface_id, "catalogId": catalog_id}
    if theme is not None:
        surface["theme"] = dict(theme)
    if send_data_model is not None:
        surface["sendDataModel"] = send_data_model
    return {"version": A2UI_VERSION, "createSurface": surface}


def update_components(surface_id: str, components: Sequence[A2uiComponent]) -> A2uiUpdateComponentsMessage:
    """``updateComponents``: adds or replaces components by id."""
    if not components:
        raise ValueError("updateComponents needs at least one component.")
    return {
        "version": A2UI_VERSION,
        "updateComponents": {"surfaceId": surface_id, "components": [dict(c) for c in components]},
    }


def update_data_model(
    surface_id: str, value: Any = _OMIT, *, path: Optional[str] = None
) -> A2uiUpdateDataModelMessage:
    """``updateDataModel``: sets ``value`` at ``path`` (the whole model when
    ``path`` is omitted). With no ``value``, removes the key at ``path``."""
    update: A2uiUpdateDataModel = {"surfaceId": surface_id}
    if path is not None:
        update["path"] = path
    if value is not _OMIT:
        update["value"] = value
    return {"version": A2UI_VERSION, "updateDataModel": update}


def delete_surface(surface_id: str) -> A2uiDeleteSurfaceMessage:
    """``deleteSurface``. When every surface a message draws is deleted, the
    message is removed for everyone."""
    return {"version": A2UI_VERSION, "deleteSurface": {"surfaceId": surface_id}}


def surface_messages(
    surface_id: str,
    components: Sequence[A2uiComponent],
    *,
    data_model: Any = _OMIT,
    catalog_id: str = RELAY_A2UI_CATALOG_ID,
    theme: Optional[Mapping[str, Any]] = None,
    send_data_model: Optional[bool] = None,
) -> List[A2uiServerMessage]:
    """A new surface: ``createSurface``, ``updateComponents`` and, when
    ``data_model`` is given, an ``updateDataModel`` for the whole model."""
    messages: List[A2uiServerMessage] = [
        create_surface(surface_id, catalog_id=catalog_id, theme=theme, send_data_model=send_data_model),
        update_components(surface_id, components),
    ]
    if data_model is not _OMIT:
        messages.append(update_data_model(surface_id, data_model))
    return messages


def a2ui_part(messages: Sequence[A2uiMessage]) -> A2uiDataPart:
    """The message part that carries ``messages``, in order."""
    if not messages:
        raise ValueError("An A2UI data part needs at least one message.")
    return {"type": "data", "media_type": A2UI_MEDIA_TYPE, "data": list(messages)}


# Send ---------------------------------------------------------------------------


async def send_a2ui(
    relay: Relay,
    chat_id: str,
    messages: Sequence[A2uiMessage],
    *,
    text: Optional[str] = None,
    reply_to: Optional[ReplyTo] = None,
    idempotency_key: Optional[str] = None,
    silent: Optional[bool] = None,
) -> SendMessageResponse:
    """Send A2UI messages to a chat, after an optional ``text`` part. With no
    ``text``, the chat list and notification show the card's first ``Text``."""
    parts: List[Dict[str, Any]] = []
    if text is not None:
        parts.append({"type": "text", "value": text})
    parts.append(cast(Dict[str, Any], a2ui_part(messages)))
    message: Dict[str, Any] = {"parts": parts}
    if reply_to is not None:
        message["reply_to"] = dict(reply_to)
    if idempotency_key is not None:
        message["idempotency_key"] = idempotency_key
    if silent is not None:
        message["silent"] = silent
    return await relay.chats.messages.send(chat_id, {"message": message})


async def send_a2ui_surface(
    relay: Relay,
    chat_id: str,
    surface_id: str,
    components: Sequence[A2uiComponent],
    *,
    data_model: Any = _OMIT,
    catalog_id: str = RELAY_A2UI_CATALOG_ID,
    theme: Optional[Mapping[str, Any]] = None,
    send_data_model: Optional[bool] = None,
    text: Optional[str] = None,
    reply_to: Optional[ReplyTo] = None,
    idempotency_key: Optional[str] = None,
    silent: Optional[bool] = None,
) -> SendMessageResponse:
    """Send a new card (:func:`surface_messages`). The response's ``message`` is the card's message."""
    messages = surface_messages(
        surface_id,
        components,
        data_model=data_model,
        catalog_id=catalog_id,
        theme=theme,
        send_data_model=send_data_model,
    )
    return await send_a2ui(
        relay, chat_id, messages, text=text, reply_to=reply_to, idempotency_key=idempotency_key, silent=silent
    )


async def update_a2ui_surface(
    relay: Relay,
    chat_id: str,
    surface_id: str,
    *,
    components: Optional[Sequence[A2uiComponent]] = None,
    data_model: Any = _OMIT,
    path: Optional[str] = None,
    text: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> SendMessageResponse:
    """Change a live card in place for every member: ``updateComponents`` for
    ``components``, then ``updateDataModel`` setting ``data_model`` at ``path``.

    The send adds no message unless ``text`` is given; without it, the
    response's ``message`` is the card's message.
    """
    messages: List[A2uiMessage] = []
    if components:
        messages.append(update_components(surface_id, components))
    if data_model is not _OMIT or path is not None:
        messages.append(update_data_model(surface_id, data_model, path=path))
    if not messages:
        raise ValueError("update_a2ui_surface needs components, data_model or path.")
    return await send_a2ui(relay, chat_id, messages, text=text, idempotency_key=idempotency_key)


async def delete_a2ui_surface(
    relay: Relay, chat_id: str, surface_id: str, *, idempotency_key: Optional[str] = None
) -> SendMessageResponse:
    """``deleteSurface``. A message whose every surface is deleted reads back
    with no parts and a non-null ``unsent_at``."""
    return await send_a2ui(relay, chat_id, [delete_surface(surface_id)], idempotency_key=idempotency_key)


# Read -------------------------------------------------------------------------


@dataclass(frozen=True)
class A2uiTap:
    """One A2UI ``action`` from a ``message.received``: a Button tap on a card."""

    #: The tapped Button's ``action.event.name``.
    name: str
    surface_id: str
    source_component_id: str
    timestamp: str
    #: The Button's ``action.event.context``, bindings resolved.
    context: Dict[str, Any]
    #: The A2UI message exactly as it arrived.
    action: A2uiAction
    chat_id: str
    #: The tap's own message id (not the card's).
    message_id: str
    #: The Relay handle of whoever tapped, for example ``advait``.
    sender_handle: Optional[str]
    #: The surface's data model when it was created with ``sendDataModel``.
    data_model: Optional[Dict[str, Any]]


def _event(payload: Union[Mapping[str, Any], str, bytes]) -> Mapping[str, Any]:
    if isinstance(payload, (str, bytes, bytearray)):
        loaded = json.loads(payload)
        if not isinstance(loaded, dict):
            raise ValueError("A Relay event is a JSON object.")
        return loaded
    return payload


def _message(payload: Union[Mapping[str, Any], str, bytes]) -> Optional[Mapping[str, Any]]:
    """The message of a ``message.received``/``message.sent`` envelope, or the
    message itself when given one."""
    event = _event(payload)
    if "event_type" in event:
        if event.get("event_type") not in ("message.received", "message.sent"):
            return None
        data = event.get("data")
        return data if isinstance(data, Mapping) else None
    return event


def is_a2ui_part(part: Any) -> bool:
    return (
        isinstance(part, Mapping)
        and part.get("type") == "data"
        and part.get("media_type") == A2UI_MEDIA_TYPE
        and isinstance(part.get("data"), list)
    )


def a2ui_messages(payload: Union[Mapping[str, Any], str, bytes]) -> List[A2uiMessage]:
    """Every A2UI message in a message's data parts, in order. ``payload`` is a
    webhook or WebSocket event (a dict, or the raw JSON body) or a message."""
    message = _message(payload)
    if message is None:
        return []
    parts = message.get("parts")
    if not isinstance(parts, list):
        return []
    return [
        cast(A2uiMessage, item)
        for part in parts
        if is_a2ui_part(part)
        for item in part["data"]
        if isinstance(item, Mapping)
    ]


def read_a2ui_actions(payload: Union[Mapping[str, Any], str, bytes]) -> List[A2uiTap]:
    """The taps in a ``message.received`` event; empty for any other event."""
    event = _event(payload)
    if event.get("event_type") != "message.received":
        return []
    message = _message(event)
    if message is None:
        return []
    chat = message.get("chat")
    chat_id = chat.get("id") if isinstance(chat, Mapping) else None
    sender = message.get("sender_handle")
    sender_handle = sender.get("handle") if isinstance(sender, Mapping) else None
    metadata = message.get("metadata")
    client_model = metadata.get("a2uiClientDataModel") if isinstance(metadata, Mapping) else None
    surfaces = client_model.get("surfaces") if isinstance(client_model, Mapping) else None
    taps: List[A2uiTap] = []
    for item in a2ui_messages(message):
        action = item.get("action")
        if not isinstance(action, Mapping):
            continue
        tapped = cast(A2uiAction, action)
        model = surfaces.get(tapped["surfaceId"]) if isinstance(surfaces, Mapping) else None
        taps.append(
            A2uiTap(
                name=tapped["name"],
                surface_id=tapped["surfaceId"],
                source_component_id=tapped["sourceComponentId"],
                timestamp=tapped["timestamp"],
                context=dict(tapped.get("context") or {}),
                action=tapped,
                chat_id=str(chat_id),
                message_id=str(message.get("id")),
                sender_handle=sender_handle if isinstance(sender_handle, str) else None,
                data_model=dict(model) if isinstance(model, Mapping) else None,
            )
        )
    return taps


def read_a2ui_action(payload: Union[Mapping[str, Any], str, bytes]) -> Optional[A2uiTap]:
    """The first tap in a ``message.received`` event, or ``None``."""
    taps = read_a2ui_actions(payload)
    return taps[0] if taps else None


def client_capabilities(payload: Union[Mapping[str, Any], str, bytes]) -> List[str]:
    """The catalog ids the reader's app draws (``metadata.a2uiClientCapabilities``),
    in order of preference; pick the first your agent can write."""
    message = _message(payload)
    metadata = message.get("metadata") if message is not None else None
    capabilities = metadata.get("a2uiClientCapabilities") if isinstance(metadata, Mapping) else None
    family = capabilities.get("v0.9") if isinstance(capabilities, Mapping) else None
    ids = family.get("supportedCatalogIds") if isinstance(family, Mapping) else None
    return [i for i in ids if isinstance(i, str)] if isinstance(ids, list) else []


__all__ = [
    "A2UI_MEDIA_TYPE",
    "A2UI_VERSION",
    "A2UI_BASIC_CATALOG_ID",
    "RELAY_A2UI_CATALOG_ID",
    "A2uiAction",
    "A2uiActionMessage",
    "A2uiCatalogs",
    "A2uiClientCapabilities",
    "A2uiClientDataModel",
    "A2uiClientMessage",
    "A2uiComponent",
    "A2uiCreateSurface",
    "A2uiCreateSurfaceMessage",
    "A2uiDataPart",
    "A2uiDeleteSurface",
    "A2uiDeleteSurfaceMessage",
    "A2uiError",
    "A2uiErrorMessage",
    "A2uiMessage",
    "A2uiServerMessage",
    "A2uiTap",
    "A2uiUpdateComponents",
    "A2uiUpdateComponentsMessage",
    "A2uiUpdateDataModel",
    "A2uiUpdateDataModelMessage",
    "A2uiVersion",
    "a2ui_messages",
    "a2ui_part",
    "surface_messages",
    "client_capabilities",
    "create_surface",
    "delete_a2ui_surface",
    "delete_surface",
    "is_a2ui_part",
    "read_a2ui_action",
    "read_a2ui_actions",
    "send_a2ui",
    "send_a2ui_surface",
    "update_a2ui_surface",
    "update_components",
    "update_data_model",
]
