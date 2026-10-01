# `@relaymessenger/elevenlabs`

`@relaymessenger/elevenlabs` puts an [ElevenLabs Agent](https://elevenlabs.io/docs/eleven-agents)
on a Relay Call. ElevenLabs runs the conversation (speech recognition, the
model, the voice, turn-taking); this package carries the audio both ways over
the ElevenLabs Agents WebSocket, the way ElevenLabs' own
[LiveKit bridge](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-engine/livekit-integration)
carries a LiveKit room. The Relay SDK's call transport owns the WebRTC peer.

```sh
npm install @relaymessenger/sdk @relaymessenger/elevenlabs
```

## Answer a Call

Agents receive `call.created` through a signed Webhook or the acknowledged
Agent WebSocket. Joining that Call answers it:

```ts
import Relay from "@relaymessenger/sdk";
import { ElevenLabsCall } from "@relaymessenger/elevenlabs";

const relay = new Relay({ apiKey: process.env.RELAY_AGENT_TOKEN! });

async function answer(callId: string) {
  const call = await ElevenLabsCall.connect({
    relay,
    callId,
    elevenlabs: { apiKey: process.env.ELEVENLABS_API_KEY!, agentId: process.env.ELEVENLABS_AGENT_ID! },
  });
  await call.closed; // the Call ended, or ElevenLabs ended the conversation
}
```

`connect()` joins the Call, then mints a signed URL
(`GET /v1/convai/conversation/get-signed-url` with your `xi-api-key`) and
opens the conversation. Pass `signedUrl` to mint it yourself with
`getSignedUrl`, or only `agentId` for a public agent. `initiationData` is sent
as `conversation_initiation_client_data` (overrides and dynamic variables).

| ElevenLabs event | What the bridge does |
| --- | --- |
| `audio` | Plays `audio_base_64` into the Call. Audio from a reply the caller already interrupted is dropped by `event_id`, as ElevenLabs' Python SDK does. |
| `interruption` | Drops the agent's audio that has not played yet. |
| `ping` | Answers with `pong` and the same `event_id`. |
| Every event | Handed to `onEvent` (transcripts, responses, tool calls). |

The caller's audio goes to ElevenLabs as `user_audio_chunk` at
`inputSampleRate` (default 16000, ElevenLabs' `pcm_16000`); it must match the
agent's `user_input_audio_format`. The agent may speak `pcm_8000`, `pcm_16000`,
`pcm_24000`, `pcm_44100` or `pcm_48000`; `pcm_22050` and `ulaw_8000` are
refused at connect. The caller's audio from while the session starts is sent
once it is ready. When ElevenLabs ends the conversation, the bridge ends the
Call; when the Call ends or its room closes, it closes the conversation, and a
hang-up during startup makes `connect()` reject.

## A Rive character's mouth

If the Relay agent's profile has a Rive file, the phone draws it during the
call. Each `audio` event's `alignment` (characters and their start times)
becomes `viseme` numbers on the file's View Model, Preston Blair's ten mouths
from 0 rest to 9 WQ, timed against the agent's audio so the mouth moves when
the words are heard; `speaking` is true while the agent talks. Rename them
with `rive: { viseme, speaking }`, pass `null` for one, or `rive: false` to
send nothing. Each change goes out about 300 ms before its audio is sent, so
an interruption drops the ones whose audio never plays. `call.rive` is set once
the channel opens (shapes from earlier audio wait for it); use it to set other
values, fire triggers and switch files.

`examples/answer-calls.ts` answers every Call with one agent.
