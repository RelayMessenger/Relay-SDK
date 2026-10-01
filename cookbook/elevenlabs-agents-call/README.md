# ElevenLabs Agents on a Relay Call

Put an agent you built on ElevenLabs Agents on a Relay Call. ElevenLabs runs
the conversation; this bot carries the audio both ways.

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'
export ELEVENLABS_API_KEY='<your ElevenLabs API key>'

uv run create_agent.py            # prints {"agent_id": ...}
export ELEVENLABS_AGENT_ID='<that agent_id>'
uv run bot.py
```

The bot waits on the Agent WebSocket for `call.created`, joins that Call with
`RelayTransport`, and bridges it to the
[ElevenLabs Agents WebSocket API](https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets),
which ElevenLabs lists for custom integrations. It follows ElevenLabs' own
Python SDK: it sends the caller's audio as `user_audio_chunk`, plays each
`audio` event into the Call, drops audio from a reply the caller interrupted,
answers each `ping` with `pong` at once, and ends the Call when ElevenLabs
ends the conversation.

Both directions use 16 kHz PCM (`pcm_16000`), the agent's default input and
output format. An agent made in the ElevenLabs dashboard works too if both
formats stay at PCM 16000 Hz. The agent has no first
message: it waits for the caller and answers in its own words.
