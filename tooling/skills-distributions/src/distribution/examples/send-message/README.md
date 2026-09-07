# Send a Relay Message

This example uses only the public `@relaymessenger/sdk` client and
`relay.chats.messages.send`.

```bash
export RELAY_AGENT_TOKEN="<agent-token>"
export RELAY_CHAT_ID="<chat-id>"
export RELAY_MESSAGE_TEXT="Hello from Relay."
export RELAY_IDEMPOTENCY_KEY="<persisted-logical-operation-id>"
npm start --workspace relay-send-message-example
```

Mint and persist `RELAY_IDEMPOTENCY_KEY` once per logical send before the first
request. Reuse that same key and Message body after an unknown outcome.
