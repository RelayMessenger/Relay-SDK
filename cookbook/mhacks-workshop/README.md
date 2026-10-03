# MHacks workshop: build an agent people text and video call

Build your own character in Relay with any coding agent, one step at a time.
Grok writes its texts, Grok Imagine draws it and makes it move, and ElevenLabs
gives it a voice. After each step, open Relay on your phone to see it working.

## Before you start

You need Node.js 22 or newer, a coding agent, and the Relay app on your phone.
Get an xAI API key at https://console.x.ai and an ElevenLabs API key at
https://elevenlabs.io.

Sign in to Relay. `login` opens your browser; sign in with Google or Apple.
`@latest` makes sure you run the newest version:

```sh
npx relaymessenger@latest login
```

Add your xAI key:

```sh
export XAI_API_KEY='paste-your-xai-key'
```

Add your ElevenLabs key:

```sh
export ELEVENLABS_API_KEY='paste-your-elevenlabs-key'
```

Make a folder for your agent:

```sh
mkdir my-agent && cd my-agent
```

Open the `my-agent` folder in your coding agent and paste each step below. Fill in the
parts in square brackets.

## Step 1: make your agent and text it

```text
Connect this project to Relay. Read https://docs.relayapp.im/llms.txt and follow its Agent onboarding section. Make an agent called [name]. [Who it is and how it talks, in a sentence or two.] Use grok-4.7 for its texts. Start it.
```

Open Relay and text your agent.

## Step 2: give it a face

```text
Make my agent's profile picture with grok-imagine-image-2.0: [what it looks like]. Put it on its contact card.
```

## Step 3: make it move

```text
Use grok-imagine-video-1.5-lite to turn its profile picture into two short videos: one of it talking and one of it listening.
```

## Step 4: give it a voice and video call it

```text
Let people call my agent. Use ElevenLabs eleven_v4_turbo for its voice, with grok-4.20-0309-non-reasoning as the brain on calls. While it talks, show the talking video; while it listens, show the listening video.
```

Video call your agent from Relay.

## Make it yours

```text
Make a character sheet of my agent: front, side, back and a few poses, so every picture of it looks the same.
```

```text
Make happy, hyped and sad versions of my agent, and show the one that fits what it's saying.
```

```text
Draw my agent in three art styles and let me pick one.
```

## Keep it running for judging

Your agent runs on your laptop and works while the laptop is on. To keep it up
without your laptop:

```text
Deploy my agent so it stays up when my laptop is closed.
```

## What it uses

| Part | Model |
| --- | --- |
| Texts | `grok-4.7` |
| Brain on calls | `grok-4.20-0309-non-reasoning` |
| Picture | `grok-imagine-image-2.0` |
| Videos | `grok-imagine-video-1.5-lite` |
| Voice | ElevenLabs `eleven_v4_turbo` |
| Relay | `@relaymessenger/sdk` over a WebSocket, so it needs no server |

Related recipes: [Grok Imagine agent](../grok-imagine-agent/),
[ElevenLabs voice agent](../elevenlabs-voice-agent/).
