# Send a Message

Send one idempotent text Message to an existing Chat with the Relay SDK.

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'
export RELAY_API_URL='https://api.staging.relayapp.im'

npm start --workspace @relaymessenger/cookbook-send-a-message -- \
  --chat-id '00000000-0000-0000-0000-000000000000' \
  --text 'Hey from Relay' \
  --idempotency-key 'welcome:00000000-0000-0000-0000-000000000000'
```

The idempotency key is required. If the result of a send is uncertain, retry
the same Message with the same key.

`RELAY_API_URL` must be an HTTPS origin. Plain HTTP is accepted only for a
loopback development server.
