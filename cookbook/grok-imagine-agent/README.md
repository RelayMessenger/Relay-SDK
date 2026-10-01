# Grok Imagine agent

A Relay agent that chats with Grok and sends pictures and short videos of
itself made with Grok Imagine. It also makes its own profile picture.

```sh
export RELAY_AGENT_TOKEN='<your Agent Token>'
export XAI_API_KEY='<your xAI API key>'
export REFERENCE_IMAGE='./diego.png'   # optional

npm install
npm start
```

On start, the agent makes a profile picture from the reference picture and
sets it on its Contact Card. Then it answers each message in a direct Chat
through the Agent WebSocket.

Grok decides when to send media. It has two tools:

- `send_picture` makes a picture with Grok Imagine image edits
  (`grok-imagine-image-2.0`, `POST /v1/images/edits`), uploads it, and sends it.
- `send_video` makes a picture the same way, turns it into a 6-second video
  (`grok-imagine-video-1.5`, `POST /v1/videos/generations`), and sends it.

Every picture starts from the reference picture and the same character
description, so the character looks the same each time. Without
`REFERENCE_IMAGE`, Grok Imagine draws a first portrait from the description.
Edit `CHARACTER` and `PERSONA` in `src/agent.ts` for your own character.

Chat history lives in memory and starts over after a restart. `XAI_MODEL`
selects the Grok model (default `grok-4.20-non-reasoning`); `RELAY_API_URL`
selects another Relay API origin.
