# Acknowledged WebSocket process

A long-running Node process using the SDK's acknowledged WebSocket:

- `onEvent` inserts the complete event and sequence into SQLite before it
  resolves. The SDK sends its cumulative ACK only after that promise resolves.
- `event_id` is the durable deduplication key. Work happens from the inbox,
  outside the socket callback.
- replies use `relay-example:websocket:<event_id>` as their REST Message
  idempotency key.
- `onFullSync` walks every page of `chats.listChats()` and
  `chats.messages.list()`, then replaces the local Chat/Message snapshot in one
  SQLite transaction. The SDK sends `full_sync_complete` only after that
  transaction commits.

FULL sync rebuilds current state; it does not invent historical event
envelopes or send retroactive replies. Subsequent socket events resume after
the committed checkpoint.

The example replies only in direct Chats and canonical Agent mentions in group
Chats. It validates Chat/Message ownership and duplicate identities before
committing FULL sync. The SQLite directory/file use owner-only permissions and
are bound to a non-secret fingerprint of the Agent Token plus Relay API origin.

## Run

An Agent cannot have saved Webhook subscriptions while using this transport.
Use a dedicated Agent Token and an empty subscription list.

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'
export RELAY_STATE_PATH=\"$HOME/.relay/examples/websocket/state.db\"
export RELAY_API_URL='https://api.staging.relayapp.im'
npm start --workspace @relaymessenger/cookbook-websocket-agent
```

Stop with `SIGINT` or `SIGTERM`. The SDK reconnects retryable socket failures
and refuses protocol gaps. The process makes no automatic Read or typing
claim.

An absent state parent chain is created with owner-only directories. An
existing immediate parent must be `0700`; higher ancestors must not be group-
or world-writable and must be owned by root or the current user. Missing
components and the database are created one at a time relative to open
directory descriptors with no-follow/exclusive flags; recursive pathname
creation is never used. Linux uses held `/proc/self/fd` directory descriptors.
macOS uses the audited `native/private-sqlite-openat.c` helper and the supported
`openat`, `mkdirat`, and `fstatat` APIs; `prestart`, `pretest`, and `prebuild`
compile it with the system C compiler. No unsafe `/dev/fd/<fd>/<child>`
traversal or prebuilt native binary is used. Other operating systems fail
closed. The database must be absent or an owner-owned `0600` regular file.
Symlinks and unsafe existing files fail closed without permission repair. Only
the root-owned sticky `/tmp` and `/var/tmp` system roots (plus their canonical
Darwin paths) receive the narrow writable-ancestor exception, so a private
directory created by `mkdtemp` remains valid.

The tests mock the Relay boundary and prove commit-before-callback-resolution,
complete snapshot traversal, durable deduplication, and idempotent send shape.
