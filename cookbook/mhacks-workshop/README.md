# MHacks workshop: build an agent people text and video call

Build your own character in Relay with any coding agent. Grok writes its texts,
Grok Imagine draws it and makes it move, and ElevenLabs gives it a voice.

## You need

- The Relay app on your phone
- A coding agent
- An xAI API key from https://console.x.ai
- An ElevenLabs API key from https://elevenlabs.io

## Step 1: make your agent and text it

Open an empty folder in your coding agent and paste:

```text
Connect this project to Relay. Read https://docs.relayapp.im/llms.txt and follow its Agent onboarding section. Sign me in to Relay, ask me for my xAI and ElevenLabs API keys and keep them in a .env file. Then make an agent called [name], [who it is and how it talks], using grok-4.7 for its texts, and start it.
```

Text your agent in Relay.

## Step 2: give it a face

```text
Make its profile picture with grok-imagine-image-2.0: [what it looks like].
```

## Step 3: video call it

```text
Make it callable. Use grok-imagine-video-1.5-lite to turn its picture into a talking video and a listening video, ElevenLabs eleven_v4_turbo for its voice, and grok-4.20-0309-non-reasoning as the brain on calls.
```

Video call your agent in Relay.

## Make it yours

```text
Make a character sheet of it: front, side, back and a few poses.
```

```text
Make happy, hyped and sad versions of it and show the one that fits what it's saying.
```

```text
Deploy it so it stays up when my laptop is closed.
```
