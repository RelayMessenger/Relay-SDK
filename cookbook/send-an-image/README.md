# Send an Image

Upload one image and send it to an existing Chat with the Relay SDK.

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'
export RELAY_API_URL='https://api.staging.relayapp.im'

npm start --workspace @relaymessenger/cookbook-send-an-image -- \
  --chat-id '00000000-0000-0000-0000-000000000000' \
  --file './photo.png' \
  --content-type 'image/png' \
  --idempotency-key 'photo:00000000-0000-0000-0000-000000000000'
```

Relay first allocates an Attachment, then the SDK uploads the raw bytes with
the returned upload URL and headers, then the Message references the returned
`attachment_id`.

The idempotency key is required. If the result of the Message send is
uncertain, retry it with the same key and body.
