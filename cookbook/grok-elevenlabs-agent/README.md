# Grok + ElevenLabs agent

Build a character people can text and video call in Relay. Grok writes its
texts, Grok Imagine draws it and makes it move, and ElevenLabs gives it a voice.

You build it by talking to any coding agent, one step at a time. After each step, open Relay on your phone and you'll see the
new thing working.

## What you need

- Node.js 22 or newer
- A coding agent
- The Relay app on your phone
- An xAI API key from https://console.x.ai
- An ElevenLabs API key from https://elevenlabs.io

```sh
npx relaymessenger login
export XAI_API_KEY='<your xAI API key>'
export ELEVENLABS_API_KEY='<your ElevenLabs API key>'
```

`login` opens your browser. Sign in with Google or Apple.

Then make an empty folder, open it in your coding agent, and paste each step
below. Change the character to your own.

## Step 1: make your agent and text it

> Connect this project to Relay. Read https://docs.relayapp.im/llms.txt and
> follow its Agent onboarding section. Make an agent called Diego, a squirrel
> who lives on the Diag at the University of Michigan. Confident, a little
> chaotic, always after your snacks. Use Grok for his texts. Start him.

Open Relay and text Diego. He texts back.

## Step 2: give it a face

> Make Diego's profile picture with Grok Imagine: a chubby cartoon squirrel in
> a maize and blue hoodie. Put it on his contact card.

His picture shows up in Relay.

## Step 3: make it move

> Use Grok Imagine to turn his picture into two short videos, one of him
> talking and one of him listening.

## Step 4: give it a voice and video call it

> Let people call Diego. Use ElevenLabs for his voice. While he talks, show the
> talking video; while he listens, show the listening video.

Video call Diego from Relay. He answers, talks with his ElevenLabs voice, and
moves on screen.

## Make it yours

Paste any of these:

- **Character sheet:** "Make a character sheet of Diego: front, side, back and
  a few poses, so every picture of him looks the same."
- **Emotions:** "Make happy, hyped and sad versions of Diego, and show the one
  that fits what he's saying."
- **Styles:** "Draw Diego in three art styles and let me pick one."

## Keep it running

Your agent runs on your laptop and works while the laptop is on. To keep it up
without your laptop:

> Deploy Diego so he stays up when my laptop is closed.

## How it works

| Part | What it uses |
| --- | --- |
| Texts | `grok-4.7` on xAI's API |
| Brain on calls | `grok-4.20-0309-non-reasoning`, which starts answering in under a second |
| Picture | Grok Imagine image (`grok-imagine-image-2.0`) |
| Talking and listening videos | Grok Imagine video (`grok-imagine-video-1.5-lite`) |
| Voice on calls | ElevenLabs (`eleven_v4_turbo`), with Grok as the brain and ElevenLabs Scribe hearing the caller |
| Relay | `@relaymessenger/sdk`, connected over a WebSocket, so it needs no server or public address |

Related recipes: [Grok Imagine agent](../grok-imagine-agent/),
[ElevenLabs voice agent](../elevenlabs-voice-agent/).
