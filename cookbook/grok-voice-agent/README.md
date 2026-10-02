# Grok Voice agent

Answer a Relay Call with xAI's Grok Voice Agent API: one speech-to-speech
model hears the caller, takes turns, and speaks back into the Call.

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'
export XAI_API_KEY='<your xAI API key>'

uv run bot.py
```

The bot keeps running and answers every Call. It listens for `call.created`
with the Relay SDK's Agent WebSocket client (heartbeat and reconnect
included), joins each Call with
`RelayTransport` from `relaymessenger-pipecat`, and connects it to Pipecat's
`GrokRealtimeLLMService` (`wss://api.x.ai/v1/realtime`, model
`grok-voice-latest`). Call the agent from Relay on your phone.

`XAI_VOICE` picks one of xAI's voices (default `eve`; the list is at
`GET https://api.x.ai/v1/tts/voices`). `AGENT_PERSONA` replaces the
instructions; `RELAY_BASE_URL` selects another Relay API origin.
