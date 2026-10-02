# Rating wire fixture

`rating-server.json` came from real Relay Server routes at commit
`af7f1802cbad49485c8753cb1ad503dd97ae1ada`, not handwritten payloads.
Its `source.contract_sha256` identifies the public contract used by this batch.
Only seeded dummy contacts and disposable database IDs appear here.

## Generation

In an isolated Daytona network namespace, use Server's
`server/test/rating-request.test.ts` setup: apply all migrations, seed the local
database, instantiate the Hono app and subscribe Echo to the three rating
events. Use its existing route helpers to:

1. Send seven Alice messages and three Echo messages.
2. Send Echo's standalone `{"type":"rating_request"}`; save the complete 202 body.
3. PUT Alice's rating, first `{"stars":4}`, then
   `{"stars":5,"review":"  Helped with the test.  "}`.
4. Read the card as Echo and Alice. Echo's rating is null; Alice sees her own
   stars and trimmed review.
5. DELETE Alice's rating. Read the three serialized `request_body` values from
   `messaging.webhook_event`, ordered by row ID.

`webhook_bodies` retains those strings exactly. The private exporter asserts
the event order, rating values, deletion's contact-only shape and reader
separation before writing this file. Do not hand-edit the payloads.

## Test boundaries

TypeScript and Python verify signatures over these exact bodies and deliver
their events through real loopback WebSockets, asserting handler delivery and
ACK. Those sockets emulate only the Agent WebSocket framing; they are not a
live Server WebSocket deployment test. The HTTP client test returns the actual
saved route response through its injected fetch boundary.

The generator exercised actual Server routes and PostgreSQL, not a mock
rating writer. Its UserSocket push fixture and the public SDK's loopback
socket do not prove iOS rendering or deployed webhook delivery.
