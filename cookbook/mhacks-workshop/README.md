# MHacks workshop: build an agent people text and video call

Make a character, then text it and video call it in Relay. You build it with
any coding agent, one prompt at a time.

## Before you start

You need Node.js 22 or newer, a coding agent, and the Relay app on your phone.

Sign in to Relay:

```sh
npx relaymessenger@latest login
```

Make two API keys. Keep both tabs open; your coding agent asks for them.

- xAI: https://console.x.ai (open API Keys)
- ElevenLabs: https://elevenlabs.io/app/api/api-keys

Open an empty folder in your coding agent, then paste each step.

## Step 1: generate its image

```text
Ask me for my xAI API key and save it in a .env file. Then use grok-imagine-image-2.0 to make a picture of my character and show it to me. My character is
```

Type what your character looks like after the prompt, then press Enter.

## Step 2: text it

```text
Connect this project to Relay. Read https://docs.relayapp.im/llms.txt and follow its Agent onboarding section. Make my character a Relay agent with that picture, using grok-4.7 for its texts, and start it. Its name and personality are
```

Type its name and how it talks, then press Enter. Text it in Relay.

## Step 3: generate its video

```text
Use grok-imagine-video-1.5-lite to turn its picture into two short videos, one of it talking and one of it listening, and show them to me.
```

## Step 4: call it

```text
Ask me for my ElevenLabs API key and save it in .env. Then let people voice and video call my agent: ElevenLabs eleven_v4_turbo for its voice, grok-4.20-0309-non-reasoning as its brain on calls, and the talking and listening videos on video calls.
```

Call your agent in Relay, then video call it.

## Make it yours

```text
Make a character sheet of my character: front, side, back and a few poses.
```

```text
Make happy, hyped and sad versions of my character, and show the one that fits what it's saying.
```

```text
Deploy my agent so it stays up when my laptop is closed.
```
