// A Think agent wired to per-person memory, the way a builder wires it, with
// a mock model that records the prompt each turn sends. No paid model call.
import { Think, type TurnConfig, type TurnContext } from "@cloudflare/think";
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

export type MemoryTestAgentRpc = Pick<MemoryTestAgent, "seed" | "turn">;

export const TEST_REPLY = "Noted.";

export class MemoryTestAgent extends Think {
  #chat?: PersonMemoryChat;
  #prompts: string[] = [];

  memory = personMemory(this, {
    binding: (this.env as unknown as Env).RelayPersonMemory,
    chat: async () => this.#chat,
  });

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
  async turn(chat: PersonMemoryChat, message: UIMessage): Promise<string> {
    this.#chat = chat;
    this.#prompts = [];
    await this.saveMessages([message]);
    return this.#prompts.join("\n");
  }
}

export default {
  fetch: () => new Response("not found", { status: 404 }),
};
