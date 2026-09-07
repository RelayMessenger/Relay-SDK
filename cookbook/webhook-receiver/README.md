# Signed Webhook receiver

A small Node process that verifies Relay's Standard Webhooks signature over the
exact request bytes, commits each complete event to SQLite, and only then
returns `204`.

The durable boundary is deliberate:

1. verify the signature;
2. atomically insert `event_id` and the full envelope with
   `PRAGMA synchronous=FULL`;
3. return `2xx`;
4. process from the durable inbox;
5. send with `relay-example:webhook:<event_id>` as the Message idempotency key.

A crash after step 3 is recovered from SQLite. A crash around the send repeats
the same idempotency key, so Relay does not create a second Message. The sample
handler returns text/attachment counts; replace only `metricsReply()` with
your application result.

The example replies only in direct Chats and when the receiving Agent's
structured Handle is mentioned in a group Chat. Its SQLite directory is mode
`0700`, the database is mode `0600`, and the database is bound to a non-secret
fingerprint of the Agent Token plus Relay API origin. Reusing it with another
Agent or origin fails closed.

## Run

Use an Agent Token and the signing secret shown once when you create the
Webhook subscription:

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'
export RELAY_WEBHOOK_SECRET='<your signing secret>'
export RELAY_INBOX_PATH=\"$HOME/.relay/examples/webhook/inbox.db\"
export RELAY_API_URL='https://api.staging.relayapp.im'
npm start --workspace @relaymessenger/cookbook-webhook-receiver
```

Expose `POST /webhooks/relay` over HTTPS, then register it with the current v1
resource:

```sh
curl --request POST 'https://api.relayapp.im/v1/webhook-subscriptions' \
  --header "Authorization: Bearer $RELAY_AGENT_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{
    "target_url": "https://your-host.example/webhooks/relay",
    "subscribed_events": ["message.received"]
  }'
```

The default path is the owner-only location above. An absent parent chain is
created with owner-only directories. An existing immediate parent must be
`0700`; higher ancestors must be owned by root or the current user and must not
be group- or world-writable. Missing components and the database are created
one at a time relative to open directory descriptors with no-follow/exclusive
flags; recursive pathname creation is never used. Linux uses held
`/proc/self/fd` directory descriptors. macOS uses the audited
`native/private-sqlite-openat.c` helper and the supported `openat`, `mkdirat`,
and `fstatat` APIs; `prestart`, `pretest`, and `prebuild` compile it with the
system C compiler. No unsafe `/dev/fd/<fd>/<child>` traversal or prebuilt native
binary is used. Other operating systems fail closed. The database must be
absent or an owner-owned `0600` regular file. Symlinks and unsafe existing
files fail closed without permission repair. Only the root-owned sticky `/tmp`
and `/var/tmp` system roots (plus their canonical Darwin paths) receive the
narrow writable-ancestor exception, so a private directory created by
`mkdtemp` remains valid. Do not place either secret in source control. The
tests inject signature, storage, and Relay send boundaries and make no external
request.
