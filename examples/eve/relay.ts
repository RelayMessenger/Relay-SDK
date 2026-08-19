import { createRelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    relay: createRelayAdapter({
      token: process.env.RELAY_AGENT_TOKEN!,
      webhookSecret: process.env.RELAY_WEBHOOK_SECRET!,
    }),
  },
  state: createMemoryState(),
  // Relay commits one canonical message per turn and has no draft bubble to
  // edit, so the reply posts once on completion.
  streaming: false,
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(message.text, { thread });
});

export default channel;
