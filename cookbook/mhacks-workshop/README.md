# MHacks workshop: build an agent people text and video call

Make a character, then text it and video call it in Relay. You build it with
any coding agent, one prompt at a time.

## Before you start

You need Node.js 22 or newer, a coding agent, and the Relay app on your phone.

Sign in to Relay:

```sh
npx relaymessenger@latest login
```

Make two API keys. You paste each one into a step below.

- xAI: https://console.x.ai (open API Keys)
- ElevenLabs: https://elevenlabs.io/app/api/api-keys

Open an empty folder in your coding agent, then paste each step.

## Step 1: generate its profile picture

```text
Save my xAI API key in a .env file, then use grok-imagine-image-2.0 to make my character's profile picture and show it to me. Make it a square image that fills the whole frame edge to edge: no circle, no border, no frame, no text. Show the character from the waist up, centered, facing the camera, with some space above its head, on a flat solid-color background. Here's my xAI API key, then what my character looks like:
```

After the prompt, paste your xAI key, type what your character looks like, and press Enter.

## Step 2: text it

```text
Connect this project to Relay. Read https://docs.relayapp.im/llms.txt and follow its Agent onboarding section. Make my character a Relay agent with that profile picture, using grok-4.7 for its texts, and start it. Its name and personality are
```

Type its name and how it talks, then press Enter. Text it in Relay.

## Step 3: generate its video

```text
Make two looping videos of my character for phone video calls, one talking and one listening. First use grok-imagine-image-2.0 to extend its profile picture to a vertical 9:16 frame with its mouth closed, so the video doesn't stretch it. Then use grok-imagine-video-1.5-lite with that frame to make two 7-second 9:16 videos at 720p: in the talking one its mouth moves like it's speaking, in the listening one its mouth stays closed and it blinks and nods. Keep the camera completely still and the character centered, looking at the camera. Blend the last half second into the first so each loops smoothly, remove all sound, and show them to me.
```

## Step 4: call it

```text
Save my ElevenLabs API key in .env, then let people voice and video call my agent: ElevenLabs eleven_v4_turbo for its voice, grok-4.20-0309-non-reasoning as its brain on calls, and the talking and listening videos on video calls. Here's my ElevenLabs API key:
```

After the prompt, paste your ElevenLabs key and press Enter.

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
