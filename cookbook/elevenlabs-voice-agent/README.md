# ElevenLabs voice agent

Answer a Relay Call with Grok as the brain and an ElevenLabs voice, on
Pipecat: the caller's voice goes through ElevenLabs Scribe, Grok answers, and
ElevenLabs speaks the answer back into the Call.

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'
export XAI_API_KEY='<your xAI API key>'
export ELEVENLABS_API_KEY='<your ElevenLabs API key>'

uv run bot.py
```

The bot keeps running and answers every Call. It listens for `call.created`
with the Relay SDK's Agent WebSocket client (heartbeat and reconnect
included), joins each Call with
`RelayTransport` from `relaymessenger-pipecat`, and leaves when the Call ends.
Call the agent from Relay on your phone.

| Setting | Default |
| --- | --- |
| Speech to text | `ElevenLabsRealtimeSTTService` (Scribe) |
| LLM | `OpenAIResponsesHttpLLMService` on xAI's Responses API (`https://api.x.ai/v1`), model `grok-4.20-0309-non-reasoning` (`XAI_MODEL`) |
| Voice | `ElevenLabsTTSService`, model `eleven_flash_v2_5` |
| Voice ID | `SOYHLrjzK2X1ezoPC6cr` (`ELEVENLABS_VOICE_ID`) |
| Voice settings | stability 0.3, similarity boost 0.75, style 0, speaker boost on, speed 1.2 |

The default voice is Diego's: "Harry", the highest-pitched male premade voice,
which every ElevenLabs plan can use through the API. A voice from the Voice Library or Voice Design needs a paid
ElevenLabs plan. `AGENT_PERSONA` replaces the system prompt; `RELAY_BASE_URL`
selects the Relay API origin and defaults to `https://api.relayapp.im`.

The call uses `grok-4.20-0309-non-reasoning` because a spoken reply must start
in under a second: it answered in 0.4 to 0.6 s, and `grok-4.7` took 1.7 to
3.3 s even at its lowest reasoning effort. The Grok Imagine chat agent keeps
`grok-4.7`, where a few seconds do not matter. `XAI_MODEL` overrides either.
