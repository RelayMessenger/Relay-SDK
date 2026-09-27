"""An echo agent: it receives each message over the Agent WebSocket and sends
the same text back as a reply.

    pip install relaymessenger
    RELAY_AGENT_TOKEN=... python echo_agent.py

Set RELAY_API_URL to use another Relay, such as https://api.staging.relayapp.im.
The agent must have no webhook subscription: an agent receives its events by
webhook or by WebSocket, not both. Stop it with Ctrl-C.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Dict

from relaymessenger import DEFAULT_BASE_URL, Relay, WebSocketEventContext, WebSocketFullSyncContext


async def main() -> None:
    relay = Relay(os.environ["RELAY_AGENT_TOKEN"], base_url=os.environ.get("RELAY_API_URL", DEFAULT_BASE_URL))

    async def on_event(event: Dict[str, Any], context: WebSocketEventContext) -> None:
        if event["event_type"] != "message.received":
            return
        message = event["data"]
        text = "\n".join(part["value"] for part in message["parts"] if part.get("type") == "text")
        if not text:
            return
        await relay.chats.messages.send(
            message["chat"]["id"],
            {
                "message": {
                    "parts": [{"type": "text", "value": text}],
                    "reply_to": {"message_id": message["id"]},
                    # The same event can arrive twice after a reconnect; the
                    # same key makes Relay send the reply only once.
                    "idempotency_key": f"echo-{event['event_id']}",
                }
            },
        )
        print(f"echoed {text!r} in chat {message['chat']['id']}", flush=True)

    def on_full_sync(context: WebSocketFullSyncContext) -> None:
        # This agent keeps no local state, so it has nothing to rebuild.
        return None

    await relay.websocket.run(
        on_event=on_event,
        on_full_sync=on_full_sync,
        on_connection_state=lambda state: print(f"websocket {state}", flush=True),
        on_error=lambda error: print(f"websocket error: {error}", flush=True),
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
