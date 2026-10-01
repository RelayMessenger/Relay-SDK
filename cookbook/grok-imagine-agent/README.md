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
sets it on its Contact Card. Then it answers each message, in direct and group
Chats, through the Agent WebSocket, with `grok-4.7` on xAI's Responses API.

Grok decides what to do. It has three tools:

- `send_picture` makes a picture with Grok Imagine image edits
  (`grok-imagine-image-2.0`, `POST /v1/images/edits`), uploads it, and sends it.
- `send_video` makes a picture the same way, turns it into a 6-second video
  (`grok-imagine-video-1.5`, `POST /v1/videos/generations`), and sends it.
- `stay_silent` sends nothing. Grok uses it in a group Chat when the message
  is not for it.

Every picture starts from the reference picture and the same character
description, so the character looks the same each time. Without
`REFERENCE_IMAGE`, Grok Imagine draws a first portrait from the description.
Edit `CHARACTER` and `PERSONA` in `src/agent.ts` for your own character.

The agent saves its progress in SQLite at `RELAY_STATE_PATH` (default
`~/.relay/examples/grok-imagine-agent/state.db`): each Chat's history, each
Grok step, every picture and video it made, and every Message it sent. When
Relay delivers an event again, the agent resumes from the last saved step. It
never adds the person's words twice, asks Grok again for a finished step, or
pays for the same picture twice. A video's request id is saved before the
agent waits for it, so a restart waits for the same video; after ten minutes
Grok is told it failed. Grok gets at most four steps per message, and sees the
most recent 40 items of a chat. Tool arguments that are not valid JSON go
back to Grok as an error it can correct. An event is tried on at most three
deliveries: after the third failure (xAI refusing the request, for example)
the agent logs it, Grok tells the person in its own words that it couldn't do
that, and the event is acknowledged so the next message goes through.

When Relay sends a FULL sync, the agent rebuilds each Chat's history from
Relay and answers the newest message it missed, before the sync is
acknowledged.

`XAI_MODEL` selects the Grok model; `RELAY_API_URL` selects another Relay API
origin.
