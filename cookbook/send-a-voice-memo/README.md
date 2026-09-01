# Send a Voice Memo

Upload one audio file and send it as a voice memo to an existing Chat with the
Relay SDK.

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'
export RELAY_API_URL='https://api.staging.relayapp.im'

npm start --workspace @relaymessenger/cookbook-send-a-voice-memo -- \
  --chat-id '00000000-0000-0000-0000-000000000000' \
  --file './voice.m4a' \
  --content-type 'audio/mp4'
```

Relay first allocates an Attachment, then the SDK uploads the raw audio bytes
with the returned upload URL and headers, then
`relay.chats.sendVoicememo()` sends that Attachment as a voice memo.
