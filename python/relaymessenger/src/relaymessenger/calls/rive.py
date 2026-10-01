"""Rive in a Relay Call: the agent drives the Rive file the phone draws.

The agent sets View Model Instance values, fires triggers and switches files,
timed against its own audio, and hears the values and triggers the phone
writes back. The TypeScript twin is ``@relaymessenger/sdk/calls`` ``rive.ts``;
every wire name lives in the block below so a rename touches one place.
"""

from __future__ import annotations

import json
import math
from typing import Any, Callable, Literal, Optional, Union

from ._events import EventEmitter

RIVE_CHANNEL = "rive"
#: A message is at most 1 KB of UTF-8 JSON.
RIVE_MESSAGE_MAX_BYTES = 1024
#: Unordered and lossy, as Cloudflare's docs advise for replaceable state
#: (realtime/sfu/datachannels.mdx): each message overwrites what it sets.
RIVE_CHANNEL_OPTIONS = {"ordered": False, "maxRetransmits": 0}

#: A View Model property value: number, boolean, string, enum (string) or color (number).
RiveValue = Union[int, float, bool, str]
RiveEvent = Literal["view_model", "trigger"]


#: JavaScript's largest exact integer: larger ints cannot round-trip to the phone and overflow math.isfinite.
_MAX_SAFE_INTEGER = 2**53 - 1


def _is_value(value: Any) -> bool:
    if isinstance(value, bool) or isinstance(value, str):
        return True
    if isinstance(value, int):
        return abs(value) <= _MAX_SAFE_INTEGER
    return isinstance(value, float) and math.isfinite(value)


def _valid_values(values: Any) -> bool:
    return (
        isinstance(values, dict)
        and len(values) > 0
        and all(isinstance(name, str) and name and _is_value(value) for name, value in values.items())
    )


def encode_rive_message(
    *,
    t: Optional[float] = None,
    view_model: Optional[dict[str, RiveValue]] = None,
    trigger: Optional[str] = None,
    file: Optional[str] = None,
    artboard: Optional[str] = None,
    state_machine: Optional[str] = None,
) -> str:
    """Serialize one message, or raise ``ValueError`` when it is malformed or over 1 KB."""
    out: dict[str, Any] = {}
    if t is not None:
        if not math.isfinite(t) or t < 0:
            raise ValueError("Rive `at` must be a finite number of milliseconds, at least 0.")
        out["t"] = math.floor(t + 0.5)  # JavaScript's Math.round, as the TypeScript SDK sends
    for key, value in (("file", file), ("artboard", artboard), ("state_machine", state_machine)):
        if value is None:
            continue
        if not isinstance(value, str) or not value:
            raise ValueError(f"Rive `{key}` must be a non-empty string.")
        out[key] = value
    if ("artboard" in out or "state_machine" in out) and "file" not in out:
        raise ValueError("Rive `artboard` and `state_machine` come with a `file`.")
    if view_model is not None:
        if not _valid_values(view_model):
            raise ValueError("Rive `view_model` maps property names to finite numbers, booleans or strings.")
        out["view_model"] = dict(view_model)
    if trigger is not None:
        if not isinstance(trigger, str) or not trigger:
            raise ValueError("Rive `trigger` needs a trigger name.")
        out["trigger"] = trigger
    if not ({"view_model", "trigger", "file"} & out.keys()):
        raise ValueError("A Rive message sets values, fires a trigger or shows a file.")
    text = json.dumps(out, separators=(",", ":"), ensure_ascii=False)
    if len(text.encode()) > RIVE_MESSAGE_MAX_BYTES:
        raise ValueError(f"A Rive message is at most {RIVE_MESSAGE_MAX_BYTES} bytes of JSON.")
    return text


def parse_rive_message(data: Union[str, bytes]) -> Optional[dict[str, Any]]:
    """One message from the phone; ``None`` for anything malformed. Unknown keys are ignored."""
    raw = data.encode() if isinstance(data, str) else bytes(data)
    if len(raw) > RIVE_MESSAGE_MAX_BYTES:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(value, dict):
        return None
    message: dict[str, Any] = {}
    if "view_model" in value:
        if not _valid_values(value["view_model"]):
            return None
        message["view_model"] = value["view_model"]
    if "trigger" in value:
        if not isinstance(value["trigger"], str) or not value["trigger"]:
            return None
        message["trigger"] = value["trigger"]
    return message or None


class RelayRive(EventEmitter[RiveEvent]):
    """The agent's handle on its ``rive`` channel, from ``transport.rive()``.

    Sends are fire-and-forget and return ``False`` while the channel is down
    (during a restart). When it reopens, the last `show` and the latest value
    of every property are sent again, untimed. Events: ``view_model`` (dict of
    values the phone wrote back) and ``trigger`` (name the phone fired).
    """

    def __init__(self, send: Callable[[str], bool]) -> None:
        super().__init__()
        self._send = send
        self._scene: Optional[dict[str, str]] = None
        self._values: dict[str, RiveValue] = {}

    def set(self, values: dict[str, RiveValue], *, at: Optional[float] = None) -> bool:
        """Set View Model Instance properties, such as ``{"viseme": 3, "speaking": True}``."""
        text = encode_rive_message(t=at, view_model=values)
        self._values.update(values)
        return self._send(text)

    def trigger(self, name: str, *, at: Optional[float] = None) -> bool:
        """Fire one trigger property, such as ``"nod"``."""
        return self._send(encode_rive_message(t=at, trigger=name))

    def show(
        self,
        file: str,
        *,
        artboard: Optional[str] = None,
        state_machine: Optional[str] = None,
        view_model: Optional[dict[str, RiveValue]] = None,
        at: Optional[float] = None,
    ) -> bool:
        """Switch to another Relay-hosted file, artboard or state machine, with optional starting values."""
        text = encode_rive_message(
            t=at, file=file, artboard=artboard, state_machine=state_machine, view_model=view_model
        )
        scene = {"file": file}
        if artboard is not None:
            scene["artboard"] = artboard
        if state_machine is not None:
            scene["state_machine"] = state_machine
        self._scene = scene
        self._values = dict(view_model or {})
        return self._send(text)

    def _receive(self, data: Union[str, bytes]) -> None:
        try:
            message = parse_rive_message(data)
        except Exception:  # nothing a peer sends may reach aiortc's receive loop as an exception
            return
        if message is None:
            return
        if "view_model" in message:
            self.emit("view_model", message["view_model"])
        if "trigger" in message:
            self.emit("trigger", message["trigger"])

    def _replay(self) -> list[str]:
        """The scene and latest values as untimed messages of at most 1 KB each."""
        messages: list[str] = []
        scene = self._scene
        if scene is not None:
            messages.append(
                encode_rive_message(
                    file=scene["file"], artboard=scene.get("artboard"), state_machine=scene.get("state_machine")
                )
            )
        batch: dict[str, RiveValue] = {}
        for name, value in self._values.items():
            candidate = {**batch, name: value}
            try:
                encode_rive_message(view_model=candidate)
                batch = candidate
            except ValueError:
                messages.append(encode_rive_message(view_model=batch))
                batch = {name: value}
        if batch:
            messages.append(encode_rive_message(view_model=batch))
        return messages
