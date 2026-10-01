/**
 * Answer every Relay Call with an ElevenLabs Agent.
 *
 *   RELAY_AGENT_TOKEN=... ELEVENLABS_API_KEY=... ELEVENLABS_AGENT_ID=... npx tsx examples/answer-calls.ts
 *
 * Waits on the acknowledged Agent WebSocket for `call.created`, joins that
 * Call (joining answers it) and bridges it to the agent until either side
 * hangs up. If the Relay agent's profile has a Rive file with a `viseme`
 * number and a `speaking` boolean, its mouth follows the voice.
 */
import Relay, { runWebSocket } from "@relaymessenger/sdk";
import { ElevenLabsCall, type ElevenLabsEvent } from "@relaymessenger/elevenlabs";

const token = process.env.RELAY_AGENT_TOKEN!;
const baseURL = process.env.RELAY_BASE_URL ?? "https://api.relayapp.im";
const relay = new Relay({ apiKey: token, baseURL });
const answered = new Set<string>();

await runWebSocket(baseURL, token, {
  // A call agent keeps no chat state, so a FULL sync has nothing to commit.
  async onFullSync() {},
  async onEvent(event) {
    if (event.event_type !== "call.created" || answered.has(event.data.call.id)) return;
    answered.add(event.data.call.id);
    const call = await ElevenLabsCall.connect({
      relay,
      callId: event.data.call.id,
      elevenlabs: { apiKey: process.env.ELEVENLABS_API_KEY!, agentId: process.env.ELEVENLABS_AGENT_ID! },
      onEvent: (message: ElevenLabsEvent) => {
        if (message.type === "user_transcript") console.log("Caller:", message.user_transcription_event);
        if (message.type === "agent_response") console.log("Agent:", message.agent_response_event);
      },
      onWarning: console.warn,
    });
    console.log(`Answered ${event.data.call.id} as ElevenLabs conversation ${call.conversationId}`);
    void call.closed.then(() => console.log(`Call ${event.data.call.id} is over`));
  },
});
