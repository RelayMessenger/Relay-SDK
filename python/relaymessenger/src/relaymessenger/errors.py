"""The SDK's errors, as ``@relaymessenger/sdk``'s errors.ts has them."""

from __future__ import annotations

from typing import Any, Optional


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

    @property
    def retryable(self) -> bool:
        return self.status is None or self.status in (408, 429) or self.status >= 500


class RelayWebhookConfiguredError(RelayAPIError):
    """The agent delivers by webhook, so Relay refused or ended its WebSocket
    (HTTP 409 on the upgrade, or close code 4410). Delete every webhook
    subscription to use the WebSocket."""

    def __init__(self, message: str, *, code: Optional[int] = None, trace_id: Optional[str] = None, body: Any = None) -> None:
        super().__init__(message, status=409, code=code, trace_id=trace_id, body=body)


class RelayUnknownEventTypeError(Exception):
    """Relay delivered an event type this SDK release does not know. The
    WebSocket skipped and acknowledged it; upgrade relaymessenger to receive it."""

    def __init__(self, event_type: str, sequence: str) -> None:
        super().__init__(
            f'Relay delivered event type "{event_type}", which this SDK release does not know; '
            "it was skipped and acknowledged. Upgrade relaymessenger to receive it."
        )
        self.event_type = event_type
        self.sequence = sequence


__all__ = ["RelayAPIError", "RelayUnknownEventTypeError", "RelayWebhookConfiguredError"]
