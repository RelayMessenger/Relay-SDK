"""A synchronous event emitter with the semantics of ``livekit.rtc.EventEmitter``.

The call core runs under any framework (LiveKit Agents, Pipecat, plain
asyncio), so it cannot inherit LiveKit's class; this copies its contract from
livekit-rtc ``event_emitter.py``: ``on``/``once`` register a callback or act
as a decorator, async callbacks are refused, each callback receives only as
many positional arguments as it declares, a callback's ``TypeError`` is
raised, and any other exception is logged and does not stop the others.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import Any, Callable, Generic, Optional, TypeVar

T_contra = TypeVar("T_contra", contravariant=True)

logger = logging.getLogger("relaymessenger.calls")


class EventEmitter(Generic[T_contra]):
    def __init__(self) -> None:
        # A dict keeps registration order and, like LiveKit's set, holds a callback once.
        self._events: dict[Any, dict[Callable[..., Any], None]] = {}

    def emit(self, event: T_contra, *args: Any) -> None:
        callbacks = self._events.get(event)
        if not callbacks:
            return
        for callback in list(callbacks):
            try:
                params = inspect.signature(callback).parameters.values()
                if any(p.kind == p.VAR_POSITIONAL for p in params):
                    callback(*args)
                else:
                    positional = [p for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
                    callback(*args[: min(len(args), len(positional))])
            except TypeError:
                raise
            except Exception:
                logger.exception("failed to emit event %s", event)

    def once(self, event: T_contra, callback: Optional[Callable[..., Any]] = None) -> Callable[..., Any]:
        if callback is None:

            def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
                self.once(event, fn)
                return fn

            return decorator
        target = callback

        def once_callback(*args: Any, **kwargs: Any) -> None:
            self.off(event, once_callback)
            target(*args, **kwargs)

        return self.on(event, once_callback)

    def on(self, event: T_contra, callback: Optional[Callable[..., Any]] = None) -> Callable[..., Any]:
        if callback is None:

            def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
                self.on(event, fn)
                return fn

            return decorator
        if asyncio.iscoroutinefunction(callback):
            raise ValueError(
                "Cannot register an async callback with `.on()`. "
                "Use `asyncio.create_task` within your synchronous callback instead."
            )
        self._events.setdefault(event, {})[callback] = None
        return callback

    def off(self, event: T_contra, callback: Callable[..., Any]) -> None:
        callbacks = self._events.get(event)
        if callbacks is not None:
            callbacks.pop(callback, None)
