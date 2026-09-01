# Direct SDK Message + Attachment

This example uses the public SDK resources directly:

1. `relay.attachments.create()` allocates an Attachment.
2. `relay.attachments.upload()` performs the raw `PUT` with Relay's returned
   upload URL and required headers.
3. `relay.chats.messages.send()` references `attachment_id` in a multipart
   Message.

The idempotency key is required input rather than a random default. Reuse the
same key and the same Message body when retrying an uncertain send.

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'
export RELAY_API_URL='https://api.staging.relayapp.im'

npm start --workspace @relaymessenger/cookbook-messages-and-attachments -- \
  --chat-id '00000000-0000-0000-0000-000000000000' \
  --file './report.pdf' \
  --content-type 'application/pdf' \
  --text 'Quarterly report' \
  --idempotency-key 'report:2026-q3'
```

The curated CLI accepts JSON, PDF, ZIP, JPEG, PNG, CSV, Markdown, and plain
text Attachments. Extend the checked content-type list with another
`SupportedContentType` from the SDK when needed.

`RELAY_API_URL` must be an HTTPS origin. Plain HTTP is accepted only for a
loopback development server, so an Agent Token cannot be sent to an arbitrary
plaintext host.

If allocation/upload succeeds but Message sending does not, retrying can leave
an extra unreferenced Attachment. Delete known unreferenced allocations with
`relay.attachments.delete(attachment_id)`.

The test replaces the SDK boundary and asserts allocation, raw upload, and
Message request order and shape. It uses no credentials or network.
