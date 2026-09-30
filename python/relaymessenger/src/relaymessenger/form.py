"""Build form prompts and discover field-keyed replies, following selection.

Text max_length defaults to 30 single-line / 300 multiline on the server.
These are defaults, not ceilings. Agents send the form; the user's answer is
plain text ``Form sent`` plus ``form_response.answers`` and an explicit reply
target. Read those field ids, never labels or the visible reply text.
"""
from __future__ import annotations

import re
import math
import unicodedata
from datetime import date
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Sequence, Set, cast

from .form_types import FormPart, FormReply

if TYPE_CHECKING:
    from .client import Relay, ReplyTo, SendMessageResponse

_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*", re.ASCII)
# Match the Server's String.trim(), including FEFF but excluding Python-only
# separators U+001C–U+001F and U+0085. Do not trim placeholders or answer values.
_TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _object(value: Any, allowed: Sequence[str], name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} needs an object")
    extra = next((key for key in value if key not in allowed), None)
    if extra is not None:
        raise ValueError(f"{name} has unknown field {extra}")
    return value


def _text(value: Any, maximum: Optional[int], name: str, trim: bool = True) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} needs a string")
    result = value.strip(_TRIM) if trim else value
    visible = any(character not in _TRIM and unicodedata.category(character) != "Cf" for character in result)
    if (trim and not visible) or (maximum is not None and len(result) > maximum):
        raise ValueError(f"{name} exceeds its character limit or is blank")
    return result


def _token(value: Any, maximum: int, name: str) -> str:
    if not isinstance(value, str) or len(value) > maximum or not _TOKEN.fullmatch(value):
        raise ValueError(f"{name} needs an ASCII token of 1 to {maximum} characters")
    return value


def _list(value: Any, maximum: Optional[int], name: str) -> Sequence[Any]:
    if not isinstance(value, (list, tuple)) or not value or (maximum is not None and len(value) > maximum):
        raise ValueError(f"{name} has an invalid item count")
    return value


def _unique(seen: Set[str], value: str, name: str) -> None:
    if value in seen:
        raise ValueError(f"duplicate {name} {value}")
    seen.add(value)


def _boolean(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} needs a boolean")
    return value


_MIN_DATE = "1900-01-01"
_MAX_DATE = "2100-12-31"
_KEYBOARDS = ("default", "email", "phone", "number", "url")


def _calendar_date(value: Any, name: str) -> str:
    try:
        if (not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value, re.ASCII)
                or value.startswith("0000") or date.fromisoformat(value).isoformat() != value):
            raise ValueError
    except ValueError:
        raise ValueError(f"{name} needs a YYYY-MM-DD calendar date") from None
    return value


def _field(value: Any, ids: Set[str]) -> Dict[str, Any]:
    common = ["id", "type", "label", "placeholder", "required"]
    raw = _object(value, common + ["multiline", "max_length", "keyboard", "multiple", "options", "min_date", "max_date"], "field")
    kind = raw.get("type")
    if kind not in ("text", "select", "picker", "date"):
        raise ValueError("unknown form field type")
    _object(raw, common + {"text": ["multiline", "max_length", "keyboard"], "select": ["multiple", "options"],
                          "picker": ["options"], "date": ["min_date", "max_date"]}[kind], "field")
    field_id = _token(raw.get("id"), 100, "field id")
    _unique(ids, field_id, "field id")
    field = {"id": field_id, "type": kind,
             "label": _text(raw.get("label"), 40 if kind == "date" else 30 if kind == "select" else 20, "field label")}
    if "placeholder" in raw:
        field["placeholder"] = _text(raw["placeholder"], None, "placeholder", False)
    if "required" in raw:
        field["required"] = _boolean(raw["required"], "required")
    if kind == "text":
        if "max_length" in raw:
            maximum = raw["max_length"]
            if (type(maximum) not in (int, float)
                    or (isinstance(maximum, float) and (not math.isfinite(maximum) or not maximum.is_integer()))
                    or not 1 <= maximum <= 9_007_199_254_740_991):
                raise ValueError("max_length needs a positive integer")
            field["max_length"] = int(maximum)
        if "multiline" in raw:
            field["multiline"] = _boolean(raw["multiline"], "multiline")
        if "keyboard" in raw:
            if raw["keyboard"] not in _KEYBOARDS:
                raise ValueError("keyboard is one of " + ", ".join(_KEYBOARDS))
            field["keyboard"] = raw["keyboard"]
    if kind == "date":
        if "min_date" in raw:
            field["min_date"] = _calendar_date(raw["min_date"], "min_date")
        if "max_date" in raw:
            field["max_date"] = _calendar_date(raw["max_date"], "max_date")
        if field.get("min_date", _MIN_DATE) > field.get("max_date", _MAX_DATE):
            raise ValueError("min_date must not be after max_date")
    if kind == "select" and "multiple" in raw:
        field["multiple"] = _boolean(raw["multiple"], "multiple")
    if kind in ("select", "picker"):
        seen: Set[str] = set()
        options = []
        for entry in _list(raw.get("options"), 20 if kind == "select" else 200, "options"):
            option = _object(entry, ["value", "label"], "option")
            option_value = _token(option.get("value"), 100, "option value")
            _unique(seen, option_value, "option value")
            options.append({"value": option_value, "label": _text(option.get("label"), 30, "option label")})
        field["options"] = options
    return field


def form_part(
    title: str, pages: Sequence[Mapping[str, Any]], *,
    show_summary: Optional[bool] = None,
    splash: Optional[Mapping[str, Any]] = None,
    received_message: Optional[Mapping[str, Any]] = None,
    reply_message: Optional[Mapping[str, Any]] = None,
) -> FormPart:
    """Validate and copy a form. Titles/labels are trimmed; field ids are not."""
    page_ids: Set[str] = set()
    field_ids: Set[str] = set()
    result: Dict[str, Any] = {"type": "form", "title": _text(title, 80, "form title"), "pages": []}
    for entry in _list(pages, None, "pages"):
        page = _object(entry, ["id", "title", "fields"], "page")
        page_id = _token(page.get("id"), 19, "page id")
        _unique(page_ids, page_id, "page id")
        result["pages"].append({
            "id": page_id, "title": _text(page.get("title"), 80, "page title"),
            "fields": [_field(field, field_ids) for field in _list(page.get("fields"), 50, "fields")],
        })
    if show_summary is not None:
        result["show_summary"] = _boolean(show_summary, "show_summary")
    if splash is not None:
        raw = _object(splash, ["title", "text", "button_title"], "splash")
        result["splash"] = {"button_title": _text(raw.get("button_title"), 35, "splash button title")}
        if "title" in raw:
            result["splash"]["title"] = _text(raw["title"], 80, "splash title")
        if "text" in raw:
            result["splash"]["text"] = _text(raw["text"], 4096, "splash text", False)
    if received_message is not None:
        raw = _object(received_message, ["title", "subtitle"], "received_message")
        result["received_message"] = {"title": _text(raw.get("title"), 512, "received title")}
        if "subtitle" in raw:
            result["received_message"]["subtitle"] = _text(raw["subtitle"], 512, "received subtitle", False)
    if reply_message is not None:
        raw = _object(reply_message, ["title", "subtitle"], "reply_message")
        if raw.get("title") != "Form sent":
            raise ValueError("reply_message title must be Form sent")
        result["reply_message"] = {"title": "Form sent"}
        if "subtitle" in raw:
            result["reply_message"]["subtitle"] = _text(raw["subtitle"], 512, "reply subtitle", False)
    return cast(FormPart, result)


def form_parts(
    title: str, pages: Sequence[Mapping[str, Any]], *, text: Optional[str] = None, **options: Any,
) -> List[Dict[str, Any]]:
    """Optional ordinary text followed by the validated form, as selection_parts."""
    part = form_part(title, pages, **options)
    parts: List[Dict[str, Any]] = []
    if text is not None and text.strip(_TRIM):
        parts.append({"type": "text", "value": text})
    parts.append(dict(part))
    return parts


async def send_form(
    relay: Relay, chat_id: str, title: str, pages: Sequence[Mapping[str, Any]], *,
    text: Optional[str] = None, reply_to: Optional[ReplyTo] = None,
    idempotency_key: Optional[str] = None, silent: Optional[bool] = None, **options: Any,
) -> SendMessageResponse:
    """Send through the existing message transport, preserving outgoing identity."""
    message: Dict[str, Any] = {"parts": form_parts(title, pages, text=text, **options)}
    if reply_to is not None:
        message["reply_to"] = dict(reply_to)
    if idempotency_key is not None:
        message["idempotency_key"] = idempotency_key
    if silent is not None:
        message["silent"] = silent
    return await relay.chats.messages.send(chat_id, {"message": message})


def form_reply(
    parts: Sequence[Mapping[str, Any]], reply_to: Optional[Mapping[str, Any]] = None,
) -> Optional[FormReply]:
    """Discover server-validated response metadata. Never infer ids from text."""
    response = next((part for part in parts if part.get("type") == "form_response"), None)
    if response is None or not reply_to or not reply_to.get("message_id"):
        return None
    index = reply_to.get("part_index")
    if type(index) is not int or index < 0:
        return None
    return {
        "answers": {key: list(value) if isinstance(value, list) else value
                    for key, value in response["answers"].items()},
        "reply_to": {"message_id": reply_to["message_id"], "part_index": index},
    }
