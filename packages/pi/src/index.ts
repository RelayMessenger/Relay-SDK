import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import Relay, { type RelayWebhookEvent } from "@relaymessenger/sdk";

export interface PiChannelOptions {
  readonly agentToken: string;
  readonly baseURL?: string;
  readonly piCommand?: string;
  readonly piArgs?: readonly string[];
  readonly spawnPi?: (command: string, args: readonly string[]) => PiProcess;
  readonly relay?: Relay;
}

export interface PiProcess {
  readonly stdin: { write(data: string): void; end(): void };
  readonly stdout: AsyncIterable<string>;
  readonly kill: () => void;
}

interface RpcRecord { readonly type?: string; readonly id?: string; readonly command?: string; readonly success?: boolean; readonly data?: { text?: string | null }; readonly error?: string }

class ChildPiProcess implements PiProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  constructor(command: string, args: readonly string[]) {
    this.#child = spawn(command, [...args], { stdio: ["pipe", "pipe", "inherit"] });
  }
  get stdin() { return this.#child.stdin; }
  get stdout() { return createInterface({ input: this.#child.stdout }); }
  kill = () => { this.#child.kill(); };
}

const textFromEvent = (event: RelayWebhookEvent): string | null => {
  if (event.event_type !== "message.received" || event.data.direction !== "inbound") return null;
  return event.data.parts.filter((part) => part.type === "text" || part.type === "link").map((part) => part.value).join("\n").trim() || null;
};

export class PiChannel {
  readonly #relay: Relay;
  readonly #options: PiChannelOptions;
  readonly #spawnPi: (command: string, args: readonly string[]) => PiProcess;
  constructor(options: PiChannelOptions) {
    if (!options.agentToken.trim()) throw new Error("Relay Agent Token is required");
    this.#options = options;
    this.#relay = options.relay ?? new Relay({ apiKey: options.agentToken, baseURL: options.baseURL });
    this.#spawnPi = options.spawnPi ?? ((command, args) => new ChildPiProcess(command, args));
  }

  async run(signal?: AbortSignal): Promise<void> {
    await this.#relay.websocket.run({
      signal,
      onEvent: async (event) => { await this.#handle(event); },
      onFullSync: async () => {},
    });
  }

  async #handle(event: RelayWebhookEvent): Promise<void> {
    const message = textFromEvent(event);
    if (!message) return;
    const pi = this.#spawnPi(this.#options.piCommand ?? "pi", ["--mode", "rpc", ...(this.#options.piArgs ?? [])]);
    try {
      const lines = pi.stdout[Symbol.asyncIterator]();
      let id = 0;
      const readResponse = async (requestId: string, command: string): Promise<RpcRecord> => {
        for (;;) {
          const item = await lines.next();
          if (item.done) throw new Error("Pi RPC process exited before responding");
          const record = JSON.parse(item.value) as RpcRecord;
          if (record.type === "response" && record.id === requestId) {
            if (record.success === false) throw new Error(record.error ?? `Pi RPC ${command} failed`);
            return record;
          }
        }
      };
      const promptId = String(++id);
      pi.stdin.write(JSON.stringify({ id: promptId, type: "prompt", message }) + "\n");
      await readResponse(promptId, "prompt");
      let settled = false;
      while (!settled) {
        const item = await lines.next();
        if (item.done) throw new Error("Pi RPC process exited before settling");
        const record = JSON.parse(item.value) as RpcRecord;
        settled = record.type === "agent_settled";
      }
      const textId = String(++id);
      pi.stdin.write(JSON.stringify({ id: textId, type: "get_last_assistant_text" }) + "\n");
      const response = await readResponse(textId, "get_last_assistant_text");
      const answer = response.data?.text?.trim();
      if (!answer) throw new Error("Pi returned no final text answer");
      await this.#relay.chats.messages.send(event.data.chat.id, {
        message: {
          parts: [{ type: "text", value: answer }],
          idempotency_key: `pi-${event.event_id}`,
        },
      });
    } finally { pi.stdin.end(); pi.kill(); }
  }
}

export const runPiChannel = (options: PiChannelOptions, signal?: AbortSignal): Promise<void> => new PiChannel(options).run(signal);
