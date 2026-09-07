# Send an Image

Upload one image and send it to an existing Chat with the Relay SDK.

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'

npm install
npm start -- \
  --chat-id '00000000-0000-0000-0000-000000000000' \
  --file './photo.png' \
  --content-type 'image/png' \
  --idempotency-key 'photo:00000000-0000-0000-0000-000000000000'
```

Copy this folder anywhere, or run it inside the Relay-SDK checkout with
`npm start --workspace @relaymessenger/cookbook-send-an-image -- <args>`.

`RELAY_API_URL` defaults to `https://api.relayapp.im`. To run against staging
instead, export `RELAY_API_URL='https://api.staging.relayapp.im'` before
starting.

Relay first allocates an Attachment, then the SDK uploads the raw bytes with
the returned upload URL and headers, then the Message references the returned
`attachment_id`.

The idempotency key applies to the final Message request, not the Attachment
allocation or upload. If that final request is uncertain, retry
`relay.chats.messages.send()` with the same `attachment_id`, key, and body.
Do not rerun this whole command: that would allocate a different Attachment
and therefore produce a different Message body.
