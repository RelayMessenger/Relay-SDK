"""The call's text chat, for a LiveKit Agents voice agent.

``relay_chat_tools`` gives the model the tools to text the person during the
call: words, buttons, a selection, a place, a link, and a location request.
``load_chat_context`` gives the model the chat's recent messages, so the call
starts where the chat left off. Both are optional; the media bridge does not
need them.

The tools are LiveKit's own raw function tools (``function_tool(raw_schema=)``),
so an ``Agent`` takes them as they are: ``Agent(tools=relay_chat_tools(...))``.
Their names and arguments are the same as the Pipecat package's.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

from livekit.agents import ChatContext, RunContext
from livekit.agents.llm import RawFunctionTool, ToolError, function_tool
from relaymessenger import Relay
from relaymessenger.parts import (
    MessagePart,
    buttons_part,
    link_part,
    place_part,
    text_part,
)
from relaymessenger.selection import selection_part

__all__ = ["CHAT_TOOL_NAMES", "load_chat_context", "relay_chat_tools"]

CHAT_TOOL_NAMES = (
    "send_message",
    "send_buttons",
    "send_selection",
    "send_place",
    "request_location",
    "read_location",
    "send_link",
)
"""The tools ``relay_chat_tools`` returns, in order."""

_TEXT = {"type": "string", "description": "The message, in your own words, as you would type it."}
_NO_ARGUMENTS: Dict[str, Any] = {"type": "object", "properties": {}, "additionalProperties": False}

_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "send_message": {
        "name": "send_message",
        "description": (
            "Texts the person in your text chat with them, during this call. They "
            "read it on their phone now and after the call. Use it when they ask "
            "you to text them something, or for what is better read than heard: "
            "a link, an address, a number, a list."
        ),
        "parameters": {"type": "object", "properties": {"text": _TEXT}, "required": ["text"], "additionalProperties": False},
    },
    "send_buttons": {
        "name": "send_buttons",
        "description": (
            "Texts the person a question with 1 to 5 buttons under it. A tap on a "
            "plain button sends its label back to you as their reply; a button "
            "with a url opens that page instead."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The question the buttons answer."},
                "buttons": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "1 to 80 characters."},
                            "url": {"type": "string", "description": "Optional http(s) page the button opens."},
                        },
                        "required": ["label"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["text", "buttons"],
            "additionalProperties": False,
        },
    },
    "send_selection": {
        "name": "send_selection",
        "description": (
            "Texts the person a list of 1 to 25 options they check in a sheet and "
            "submit once. Their choice comes back to you as a message."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "The list's title, 1 to 60 characters, e.g. \"Pizza toppings\"."},
                "options": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 25,
                    "items": {
                        "type": "object",
                        "properties": {
                            "value": {
                                "type": "string",
                                "description": "A stable unique token: letters, digits and . _ : -, 1 to 100 characters.",
                            },
                            "label": {"type": "string", "description": "What the person reads, 1 to 80 characters."},
                        },
                        "required": ["value", "label"],
                        "additionalProperties": False,
                    },
                },
                "multiple": {"type": "boolean", "description": "False to allow only one choice. Default true."},
                "text": {"type": "string", "description": "Optional words shown above the list."},
            },
            "required": ["title", "options"],
            "additionalProperties": False,
        },
    },
    "send_place": {
        "name": "send_place",
        "description": "Texts the person a place on a map they can open in their maps app.",
        "parameters": {
            "type": "object",
            "properties": {
                "latitude": {"type": "number", "minimum": -90, "maximum": 90},
                "longitude": {"type": "number", "minimum": -180, "maximum": 180},
                "name": {"type": "string", "description": "Optional: the place's name."},
                "address": {"type": "string", "description": "Optional: the place's address."},
            },
            "required": ["latitude", "longitude"],
            "additionalProperties": False,
        },
    },
    "request_location": {
        "name": "request_location",
        "description": (
            "Asks the person to share their location. Relay texts them a card with "
            "a Share My Location button, and they choose how long to share. Then "
            "read it with read_location."
        ),
        "parameters": _NO_ARGUMENTS,
    },
    "read_location": {
        "name": "read_location",
        "description": (
            "Reads where the person sharing their location with you is now: "
            "latitude, longitude, and when that position arrived. Returns "
            "not_sharing when nobody is sharing."
        ),
        "parameters": _NO_ARGUMENTS,
    },
    "send_link": {
        "name": "send_link",
        "description": "Texts the person a link, shown as a preview card.",
        "parameters": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "An http(s) URL."}},
            "required": ["url"],
            "additionalProperties": False,
        },
    },
}


def _text(arguments: Mapping[str, Any], key: str) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ToolError(f"{key} is required")
    return value.strip()


def relay_chat_tools(relay: Relay, chat_id: str) -> List[RawFunctionTool[Any, Any]]:
    """LiveKit tools that act in the call's chat as the agent.

    Each send's idempotency key is the chat and LiveKit's tool call id, so a
    retried request never sends the same message twice. A refusal from Relay
    or a bad argument comes back to the model as a ``ToolError``."""

    async def send(parts: List[MessagePart], context: RunContext[Any]) -> Dict[str, Any]:
        message: Dict[str, Any] = {
            "parts": parts,
            "idempotency_key": f"livekit:{chat_id}:{context.function_call.call_id}",
        }
        try:
            response = await relay.chats.messages.send(chat_id, {"message": message})
        except Exception as error:
            raise ToolError(f"send failed: {error}") from error
        return {"status": "sent", "message_id": response.get("message", {}).get("id")}

    def build(make: Any) -> List[MessagePart]:
        try:
            return list(make())
        except ValueError as error:
            raise ToolError(str(error)) from error

    @function_tool(raw_schema=_SCHEMAS["send_message"])
    async def send_message(raw_arguments: Dict[str, object], context: RunContext[Any]) -> Dict[str, Any]:
        text = _text(raw_arguments, "text")
        return await send([text_part(text)], context)

    @function_tool(raw_schema=_SCHEMAS["send_buttons"])
    async def send_buttons(raw_arguments: Dict[str, object], context: RunContext[Any]) -> Dict[str, Any]:
        text = _text(raw_arguments, "text")
        items = raw_arguments.get("buttons")
        if not isinstance(items, list):
            raise ToolError("buttons is required")
        return await send(build(lambda: [text_part(text), buttons_part(items)]), context)

    @function_tool(raw_schema=_SCHEMAS["send_selection"])
    async def send_selection(raw_arguments: Dict[str, object], context: RunContext[Any]) -> Dict[str, Any]:
        title = _text(raw_arguments, "title")
        options = raw_arguments.get("options")
        if not isinstance(options, list):
            raise ToolError("options is required")
        extra: Dict[str, Any] = {}
        if "multiple" in raw_arguments:
            extra["multiple"] = raw_arguments["multiple"]
        words = raw_arguments.get("text")

        def make() -> List[MessagePart]:
            selection: MessagePart = selection_part(title, options, **extra)
            if isinstance(words, str) and words.strip():
                return [text_part(words.strip()), selection]
            return [selection]

        return await send(build(make), context)

    @function_tool(raw_schema=_SCHEMAS["send_place"])
    async def send_place(raw_arguments: Dict[str, object], context: RunContext[Any]) -> Dict[str, Any]:
        latitude, longitude = raw_arguments.get("latitude"), raw_arguments.get("longitude")
        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            raise ToolError("latitude and longitude are numbers")
        name, address = raw_arguments.get("name"), raw_arguments.get("address")
        return await send(build(lambda: [place_part(
            float(latitude), float(longitude),
            name=name if isinstance(name, str) else None,
            address=address if isinstance(address, str) else None,
        )]), context)

    @function_tool(raw_schema=_SCHEMAS["send_link"])
    async def send_link(raw_arguments: Dict[str, object], context: RunContext[Any]) -> Dict[str, Any]:
        url = _text(raw_arguments, "url")
        if not url.startswith(("http://", "https://")):
            raise ToolError("url is an http(s) URL")
        return await send([link_part(url)], context)

    @function_tool(raw_schema=_SCHEMAS["request_location"])
    async def request_location(raw_arguments: Dict[str, object]) -> Dict[str, Any]:
        try:
            await relay.chats.location.request(chat_id)
        except Exception as error:
            raise ToolError(f"location request failed: {error}") from error
        return {"status": "requested"}

    @function_tool(raw_schema=_SCHEMAS["read_location"])
    async def read_location(raw_arguments: Dict[str, object]) -> Dict[str, Any]:
        try:
            response = await relay.chats.location.retrieve(chat_id)
        except Exception as error:
            raise ToolError(f"location read failed: {error}") from error
        features = response["data"]["features"]
        if not features:
            return {"status": "not_sharing"}
        return {
            "status": "sharing",
            "locations": [
                {
                    "handle": feature["properties"].get("handle"),
                    "latitude": feature["geometry"]["coordinates"][1],
                    "longitude": feature["geometry"]["coordinates"][0],
                    "updated_at": feature["properties"].get("updated_at"),
                }
                for feature in features
            ],
        }

    return [send_message, send_buttons, send_selection, send_place, request_location, read_location, send_link]


def _words(parts: List[Mapping[str, Any]]) -> str:
    """The message as the model reads it: its text, links and places."""
    words: List[str] = []
    for part in parts:
        kind = part.get("type")
        if kind == "text" and isinstance(part.get("value"), str):
            words.append(part["value"])
        elif kind == "link" and isinstance(part.get("value"), str):
            words.append(part["value"])
        elif kind == "place":
            label = part.get("name") or part.get("address") or f"{part.get('latitude')}, {part.get('longitude')}"
            words.append(f"[place: {label}]")
        elif kind == "selection" and isinstance(part.get("title"), str):
            words.append(f"[selection: {part['title']}]")
        elif kind == "selection_response" and isinstance(part.get("selected_values"), list):
            words.append(f"[selected: {', '.join(map(str, part['selected_values']))}]")
        elif kind == "media":
            words.append("[media]")
    return "\n".join(words)


async def load_chat_context(
    relay: Relay, chat_id: str, limit: int = 20, *, chat_ctx: Optional[ChatContext] = None,
) -> ChatContext:
    """The chat's ``limit`` most recent messages, oldest first, as LiveKit chat
    items: the person's as ``user``, the agent's as ``assistant``. System
    messages and messages with nothing to read are left out. Pass
    ``chat_ctx`` to add them to an existing context, such as an ``Agent``'s
    ``chat_ctx`` before the instructions are set."""
    page = await relay.chats.messages.list(chat_id, limit=limit, order="desc")
    context = chat_ctx if chat_ctx is not None else ChatContext.empty()
    for message in reversed(page["messages"]):
        if message.get("is_system_message"):
            continue
        content = _words(message.get("parts") or [])
        if not content:
            continue
        context.add_message(
            role="assistant" if message.get("is_from_me") else "user",
            content=content,
            id=str(message["id"]),
        )
    return context
