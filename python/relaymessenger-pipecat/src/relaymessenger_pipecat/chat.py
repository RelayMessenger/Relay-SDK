"""Relay chat tools for a Pipecat bot: text the person, and use Relay's
interactive parts, during a Call.

The tools are Pipecat function calling (docs.pipecat.ai/guides/learn/function-calling):
a ``ToolsSchema`` for the LLM context and one handler per tool, registered with
``llm.register_function``. Every handler calls the Relay SDK and builds its
parts with the SDK's own helpers (``relaymessenger.parts``,
``relaymessenger.selection``), so the limits match the SDK's.

``load_chat_context`` reads the chat's recent messages as LLM context
messages, so the bot knows the chat before it speaks.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.services.llm_service import FunctionCallParams
from relaymessenger import Relay
from relaymessenger.parts import buttons_part, link_part, place_part, text_part
from relaymessenger.selection import send_selection

Handler = Callable[[FunctionCallParams], Awaitable[None]]

_TEXT = {"type": "string", "description": "The message, as you would type it."}

SEND_MESSAGE = FunctionSchema(
    name="send_message",
    description=(
        "Texts the person in your chat with them. They read it on their phone now "
        "and after the call. Use it for what is better read than heard: a number, an address, a list."
    ),
    properties={
        "text": _TEXT,
        "reply_to_message_id": {"type": "string", "description": "A message in the chat to reply to."},
    },
    required=["text"],
)

SEND_BUTTONS = FunctionSchema(
    name="send_buttons",
    description=(
        "Texts the person a question with 1 to 5 buttons under it. A tap on a button "
        "sends its label back to you; a button with a url opens that page instead."
    ),
    properties={
        "text": {"type": "string", "description": "The question the buttons answer."},
        "buttons": {
            "type": "array",
            "minItems": 1,
            "maxItems": 5,
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "description": "The button's text, at most 80 characters."},
                    "url": {"type": "string", "description": "An https page the button opens."},
                },
                "required": ["label"],
            },
        },
    },
    required=["text", "buttons"],
)

SEND_SELECTION = FunctionSchema(
    name="send_selection",
    description=(
        "Texts the person a list of 1 to 25 options to pick from. They see the title "
        "and the options, pick one or more, and their pick comes back to you."
    ),
    properties={
        "title": {"type": "string", "description": "The list's title, at most 60 characters."},
        "options": {
            "type": "array",
            "minItems": 1,
            "maxItems": 25,
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Your id for the option."},
                    "label": {"type": "string", "description": "The option's text, at most 24 characters."},
                    "subtitle": {"type": "string", "description": "A line under the label."},
                },
                "required": ["id", "label"],
            },
        },
        "multiple": {"type": "boolean", "description": "Whether the person can pick more than one. Default true."},
        "text": {"type": "string", "description": "A message above the list."},
    },
    required=["title", "options"],
)

SEND_PLACE = FunctionSchema(
    name="send_place",
    description="Texts the person a place. They see it on a map and can open directions.",
    properties={
        "latitude": {"type": "number"},
        "longitude": {"type": "number"},
        "name": {"type": "string", "description": "The place's name."},
        "address": {"type": "string", "description": "The place's address."},
    },
    required=["latitude", "longitude"],
)

REQUEST_LOCATION = FunctionSchema(
    name="request_location",
    description=(
        "Asks the person to share their location with you. They see a request in the "
        "chat; once they share, read_location returns it."
    ),
    properties={},
    required=[],
)

READ_LOCATION = FunctionSchema(
    name="read_location",
    description="Reads the locations the person shares with you in this chat. Empty when they share none.",
    properties={},
    required=[],
)

SEND_LINK = FunctionSchema(
    name="send_link",
    description="Texts the person a link. They see the page's preview and can open it.",
    properties={"url": {"type": "string", "description": "An https URL."}},
    required=["url"],
)

CHAT_TOOLS = [SEND_MESSAGE, SEND_BUTTONS, SEND_SELECTION, SEND_PLACE, REQUEST_LOCATION, READ_LOCATION, SEND_LINK]
"""The schemas ``relay_chat_tools`` registers, in order."""


@dataclass
class RelayChatTools:
    """The chat tools for one chat: ``tools`` goes in the LLM context, and
    ``register(llm)`` registers a handler for each."""

    tools: ToolsSchema
    handlers: dict[str, Handler] = field(default_factory=dict)

    def register(self, llm: Any) -> None:
        """Register every handler on a Pipecat ``LLMService``."""
        for name, handler in self.handlers.items():
            llm.register_function(name, handler)


def relay_chat_tools(relay: Relay, chat_id: str) -> RelayChatTools:
    """Tools that let the bot text the person in ``chat_id`` during a Call:
    send_message, send_buttons, send_selection, send_place,
    request_location, read_location and send_link.

    Each send's idempotency key is the chat and the model's tool call id, so a
    retried request never sends the same message twice. A handler reports a
    failure to the model as ``{"status": "failed", "error": ...}`` instead of
    raising, so the bot can say so."""

    def key(params: FunctionCallParams) -> str:
        return f"relay-pipecat:{chat_id}:{params.tool_call_id}"

    async def send(params: FunctionCallParams, parts: list[Any], reply_to: str | None = None) -> dict[str, Any]:
        message: dict[str, Any] = {"parts": parts, "idempotency_key": key(params)}
        if reply_to:
            message["reply_to"] = {"message_id": reply_to}
        response = await relay.chats.messages.send(chat_id, {"message": message})
        return {"status": "sent", "message_id": response.get("message", {}).get("id")}

    async def send_message(params: FunctionCallParams) -> Mapping[str, Any]:
        args = params.arguments
        return await send(params, [text_part(str(args["text"]))], args.get("reply_to_message_id"))

    async def send_buttons(params: FunctionCallParams) -> Mapping[str, Any]:
        args = params.arguments
        items = [{k: v for k, v in dict(b).items() if k in ("label", "url")} for b in args["buttons"]]
        return await send(params, [text_part(str(args["text"])), buttons_part(items)])  # type: ignore[arg-type]

    async def send_selection_tool(params: FunctionCallParams) -> Mapping[str, Any]:
        args = params.arguments
        options = [{k: v for k, v in dict(o).items() if k in ("id", "label", "subtitle")} for o in args["options"]]
        extra: dict[str, Any] = {}
        if "multiple" in args:
            extra["multiple"] = bool(args["multiple"])
        response = await send_selection(
            relay, chat_id, str(args["title"]), options, text=args.get("text"), idempotency_key=key(params), **extra
        )
        return {"status": "sent", "message_id": response.get("message", {}).get("id")}

    async def send_place(params: FunctionCallParams) -> Mapping[str, Any]:
        args = params.arguments
        part = place_part(
            float(args["latitude"]), float(args["longitude"]), name=args.get("name"), address=args.get("address")
        )
        return await send(params, [part])

    async def request_location(params: FunctionCallParams) -> Mapping[str, Any]:
        await relay.chats.location.request(chat_id)
        return {"status": "requested"}

    async def read_location(params: FunctionCallParams) -> Mapping[str, Any]:
        response = await relay.chats.location.retrieve(chat_id)
        locations = []
        for feature in response["data"]["features"]:
            longitude, latitude = feature["geometry"]["coordinates"][:2]
            locations.append({"latitude": latitude, "longitude": longitude, **feature.get("properties", {})})
        return {"status": "ok", "locations": locations}

    async def send_link(params: FunctionCallParams) -> Mapping[str, Any]:
        return await send(params, [link_part(str(params.arguments["url"]))])

    def tool(run: Callable[[FunctionCallParams], Awaitable[Mapping[str, Any]]]) -> Handler:
        async def handler(params: FunctionCallParams) -> None:
            try:
                result = await run(params)
            except Exception as error:
                logger.warning(f"Relay chat tool {params.function_name} failed: {error!r}")
                await params.result_callback({"status": "failed", "error": str(error)})
                return
            await params.result_callback(dict(result))

        return handler

    runs = {
        "send_message": send_message,
        "send_buttons": send_buttons,
        "send_selection": send_selection_tool,
        "send_place": send_place,
        "request_location": request_location,
        "read_location": read_location,
        "send_link": send_link,
    }
    return RelayChatTools(
        tools=ToolsSchema(standard_tools=list(CHAT_TOOLS)),
        handlers={name: tool(run) for name, run in runs.items()},
    )


def _message_text(parts: list[Mapping[str, Any]]) -> str:
    """One line for a message: its text, and a short note for each other part."""
    pieces: list[str] = []
    for part in parts:
        kind = part.get("type")
        if kind == "text":
            pieces.append(str(part.get("value", "")))
        elif kind == "link":
            pieces.append(str(part.get("value", "")))
        elif kind == "place":
            label = part.get("name") or part.get("address") or f"{part.get('latitude')},{part.get('longitude')}"
            pieces.append(f"[place: {label}]")
        elif kind == "buttons":
            pieces.append("[buttons: " + ", ".join(str(b.get("label")) for b in part.get("items", [])) + "]")
        elif kind == "selection":
            pieces.append(f"[selection: {part.get('title')}]")
        elif kind == "selection_response":
            pieces.append("[picked: " + ", ".join(str(v) for v in part.get("selected_values", [])) + "]")
        else:
            pieces.append(f"[{kind}]")
    return "\n".join(piece for piece in pieces if piece)


async def load_chat_context(relay: Relay, chat_id: str, limit: int = 20) -> list[dict[str, str]]:
    """The chat's last ``limit`` messages, oldest first, as LLM context
    messages: the agent's own as ``assistant``, everyone else's as ``user``.
    Put them in the ``LLMContext`` before the bot speaks."""
    page = await relay.chats.messages.list(chat_id, limit=limit, order="desc")
    context: list[dict[str, str]] = []
    for message in reversed(page["messages"]):
        content = _message_text(message.get("parts", []))
        if content:
            context.append({"role": "assistant" if message.get("is_from_me") else "user", "content": content})
    return context
