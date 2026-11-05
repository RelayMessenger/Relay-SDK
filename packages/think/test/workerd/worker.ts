// A Think agent wired to per-person memory, the way a builder wires it, with
// a mock model that records the prompt each turn sends. No paid model call.
import { Think, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type Relay from "@relaymessenger/sdk";
import type { Message } from "@relaymessenger/sdk";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import {
  personMemory,
  type PersonMemoryChat,
  RelayPersonMemory,
  type RelayPersonMemoryNamespace,
} from "../../src/memory.js";

export { RelayPersonMemory };

export interface Env {
  MemoryTestAgent: DurableObjectNamespace<MemoryTestAgent>;
  RelayPersonMemory: RelayPersonMemoryNamespace & DurableObjectNamespace<RelayPersonMemory>;
}

export type MemoryTestAgentRpc = Pick<MemoryTestAgent, "seed" | "turn" | "relayCalls">;

/** What a fake Relay holds: each Chat as GET /v1/chats/{chatId} returns it, and its Messages. */
export interface FakeRelayData {
  chats: Record<string, PersonMemoryChat>;
  messages: Record<string, Message[]>;
  /** Every call throws, the way a Relay outage does. */
  throws?: boolean;
}

/** A stand-in for the @relaymessenger/sdk client's `chats`, reading `data`. */
function fakeRelay(data: FakeRelayData, calls: string[]): Pick<Relay, "chats"> {
  return {
    chats: {
      retrieve: async (chatId: string) => {
        calls.push(`retrieve ${chatId}`);
        if (data.throws) throw new Error("Relay is down");
        const chat = data.chats[chatId];
        if (!chat) throw new Error(`404 ${chatId}`);
        return chat;
      },
      messages: {
        list: async (chatId: string, query: { order?: string; limit?: number } = {}) => {
          calls.push(`list ${chatId} ${query.order} ${query.limit}`);
          if (data.throws) throw new Error("Relay is down");
          const newest = [...(data.messages[chatId] ?? [])]
            .sort((a, b) => (b.sent_at ?? b.created_at).localeCompare(a.sent_at ?? a.created_at));
          return { data: newest.slice(0, query.limit ?? 50) };
        },
      },
    },
  } as unknown as Pick<Relay, "chats">;
}

export const TEST_REPLY = "Noted.";

export class MemoryTestAgent extends Think {
  #chat?: PersonMemoryChat;
  #prompts: string[] = [];
  #relay?: Pick<Relay, "chats">;
  #relayCalls: string[] = [];

  memory = (() => {
    const agent = this;
    return personMemory(this, {
      binding: (this.env as unknown as Env).RelayPersonMemory,
      chat: async () => agent.#chat,
      get relay() {
        return agent.#relay;
      },
    });
  })();

  override getModel() {
    return new MockLanguageModelV3({
      doStream: async ({ prompt, tools }) => {
        this.#prompts.push(JSON.stringify({ prompt, tools: (tools ?? []).map((t) => t.name) }));
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: null,
            initialDelayInMs: null,
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: TEST_REPLY },
              { type: "text-end" as const, id: "t" },
              {
                type: "finish" as const,
                finishReason: { raw: "stop", unified: "stop" as const },
                usage: {
                  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
                  outputTokens: { reasoning: 0, text: 1, total: 1 },
                },
              },
            ],
          }),
        };
      },
    });
  }

  override async beforeTurn(context: TurnContext): Promise<TurnConfig | void> {
    return await this.memory.turn(context.messages);
  }

  override async onChatResponse(): Promise<void> {
    await this.memory.ingest();
  }

  /** History that arrived before memory was on, then one ingest pass. */
  async seed(chat: PersonMemoryChat, messages: UIMessage[]): Promise<void> {
    this.#chat = chat;
    await this.addMessages(messages);
    await this.memory.ingest();
  }

  /** One real turn on a person's Message; returns the prompt the model got. */
  async turn(chat: PersonMemoryChat, message: UIMessage, relay?: FakeRelayData): Promise<string> {
    this.#chat = chat;
    this.#prompts = [];
    this.#relayCalls = [];
    this.#relay = relay ? fakeRelay(relay, this.#relayCalls) : undefined;
    await this.saveMessages([message]);
    return this.#prompts.join("\n");
  }

  /** The Relay calls the last turn made. */
  async relayCalls(): Promise<string[]> {
    return this.#relayCalls;
  }
}

export default {
  fetch: () => new Response("not found", { status: 404 }),
};
