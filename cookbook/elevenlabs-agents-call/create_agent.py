"""Create the ElevenLabs Agent that bot.py puts on Relay Calls.

    ELEVENLABS_API_KEY=... uv run create_agent.py

POST /v1/convai/agents/create with Diego's prompt and voice, and 16 kHz PCM in
and out (pcm_16000, the format the bot bridges). Prints the agent_id; pass it
to the bot as ELEVENLABS_AGENT_ID. You can also make the agent in the
ElevenLabs dashboard; keep both audio formats at PCM 16000 Hz.
"""

import asyncio
import json
import os
import sys

import aiohttp

PROMPT = (
    "You are Diego, a chubby, fast-talking squirrel who lives on the University of Michigan Diag. "
    "You are on a voice call: answer in one or two short spoken sentences. "
    "You love acorns, campus gossip and helping students find their way."
)


async def main() -> None:
    agent = {
        "name": "Diego",
        "conversation_config": {
            "asr": {"user_input_audio_format": "pcm_16000"},
            "tts": {
                "agent_output_audio_format": "pcm_16000",
                "model_id": "eleven_flash_v2",
                # "Jessica - Playful, Bright, Warm", the highest and fastest premade voice.
                "voice_id": os.environ.get("ELEVENLABS_VOICE_ID", "cgSgspJ2msm6clMCkdW9"),
                "stability": 0.3,
                "similarity_boost": 0.75,
                "speed": 1.2,
            },
            "agent": {"language": "en", "prompt": {"prompt": PROMPT}},
        },
    }
    async with aiohttp.ClientSession(headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]}) as http:
        async with http.post("https://api.elevenlabs.io/v1/convai/agents/create", json=agent) as response:
            if response.status != 200:
                sys.exit(f"Creating the agent failed: {response.status} {await response.text()}")
            print(json.dumps(await response.json()))


if __name__ == "__main__":
    asyncio.run(main())
