# Source provenance

The root history begins with a selective source snapshot from
`RelayMessenger/Relay-SDK@0ff1fb1:integrations/claude-code`.

The import retained the npm identity, MIT license, build/package foundations,
permission grammar, and durable-state design ideas. It intentionally omitted
the removed polling client, polling loop, generated runtime bundle, stale wire
types, and tests tied to former Events and Conversation APIs.

The Relay v1 implementation in the following commit was rebuilt against the
contract recorded in `contracts/relay-v1.lock.json` and current official Claude
Code Channels documentation. No Relay-SDK monorepo history or unrelated source
was imported.
