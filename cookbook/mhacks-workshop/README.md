# MHacks workshop: build an agent people text and video call

Make a character, then text it and video call it in Relay. You build it with
any coding agent, one prompt at a time.

## Before you start

You need Node.js 22 or newer, a coding agent, and the Relay app on your phone.

Sign in to Relay:

```sh
npx relaymessenger@latest login
```

Give your coding agent Relay's skill, so it knows how to build on Relay:

```sh
npx skills add RelayMessenger/Relay-SDK --skill relay
```

Make two API keys. You paste each one into a step below.

- xAI: https://console.x.ai (open API Keys)
- ElevenLabs: https://elevenlabs.io/app/api/api-keys

Open an empty folder in your coding agent, then paste each step.

## Step 1: generate its profile picture

```text
Save my xAI API key in .env, then use grok-imagine-image-2.0 to make my character's profile picture and show it to me. Make it square and fill the whole frame: no circle, border or text. Show it from the waist up, centered, facing the camera, with space above its head, on a flat solid-color background. Here's my xAI API key, then what my character looks like:
```

After the prompt, paste your xAI key, type what your character looks like, and press Enter.

## Step 2: text it

```text
Make my character a Relay agent with that profile picture, using grok-4.7 for its texts, and start it. Its name and personality are
```

Type its name and how it talks, then press Enter. It texts you in Relay; text it back.

## Step 3: generate its video

```text
Make two looping videos of my character for video calls, one talking and one listening. First use grok-imagine-image-2.0 to extend its profile picture to a 9:16 frame with its mouth closed. Then use grok-imagine-video-1.5-lite on that frame for two 7-second 9:16 videos: in one its mouth moves as it talks, in the other its mouth stays closed and it blinks and nods. Keep the camera still. Blend the last half second into the first so each loops, remove the sound, and show them to me.
```

## Step 4: call it

```text
Save my ElevenLabs API key in .env, then let people call my agent: grok-4.20-0309-non-reasoning as its brain on calls, ElevenLabs eleven_v4_turbo for its voice, and the talking and listening videos as its camera. Here's my ElevenLabs API key:
```

After the prompt, paste your ElevenLabs key and press Enter. Your agent calls
you when it's ready. Answer, then turn your camera on.
