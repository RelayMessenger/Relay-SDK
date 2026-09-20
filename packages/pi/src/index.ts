import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import Relay, {
  BUTTONS_BLOCK_INSTRUCTION,
  BUTTONS_GUIDANCE,
  selectionReply,
  selectionReplyContext,
  SELECTION_GUIDANCE,
  SELECTION_BLOCK_INSTRUCTION,
  LINK_LINE_INSTRUCTION,
  answerMessages as splitAnswer,
  type MessagePart,
  type MessageWebhookData,
  type RelayWebhookEvent,
} from "@relaymessenger/sdk";

export interface PiChannelOptions {
  readonly agentToken: string;
  readonly baseURL?: string;
  readonly piCommand?: string;
  readonly piArgs?: readonly string[];
  readonly rpcTimeoutMs?: number;
  readonly spawnPi?: (command: string, args: readonly string[], chatId: string) => PiProcess;
  readonly relay?: Relay;
}
export interface PiProcess {
  readonly stdin: { write(data: string): void; end(): void };
  readonly stdout: AsyncIterable<string>;
  readonly kill: () => void;
}
interface RpcRecord { readonly type?: string; readonly id?: string; readonly success?: boolean; readonly data?: { text?: string | null }; readonly error?: string }
class ChildPiProcess implements PiProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  constructor(command: string, args: readonly string[]) { this.#child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] }); this.#child.stderr.resume(); }
  get stdin() { return this.#child.stdin; }
  get stdout() { return createInterface({ input: this.#child.stdout }); }
  kill = () => { this.#child.kill(); };
}
const textFromEvent = (event: RelayWebhookEvent): string | null => {
  if (event.event_type !== "message.received" || event.data.direction !== "inbound") return null;
  const text = event.data.parts
    .flatMap((part) => part.type === "text" || part.type === "link" ? [part.value] : [])
    .join("\n").trim();
  if (!text) return null;
  const context = selectionReplyContext(selectionReply(event.data.parts, event.data.reply_to));
  return [text, context].filter(Boolean).join("\n\n");
};
/**
 * The prompt pi is given for one message: the words, then how to answer.
 * This process sends pi's final text for it, and the same buttons and link
 * rules every other runtime carries.
 */
export const piPrompt = (message: string): string =>
  `${message}\n\nWrite your answer as your final message. Relay sends that answer to the chat for you, so do not send it yourself. Write chat text. Inline Markdown draws: bold, italic, strikethrough, code, links. Headings, lists and code fences show as written.\n\n${BUTTONS_BLOCK_INSTRUCTION} ${LINK_LINE_INSTRUCTION} ${BUTTONS_GUIDANCE} ${SELECTION_BLOCK_INSTRUCTION} ${SELECTION_GUIDANCE}`;

/**
 * The messages an answer becomes: each link written alone on a line as its
 * own message, text in chunks the API takes, and the buttons its fenced block
 * asked for under the last words. A block pi wrote that cannot be read stays
 * in the words, so nothing the person was told is lost.
 */
export const answerMessages = (answer: string): { parts: MessagePart[]; error?: string }[] => {
  const split = splitAnswer(answer);
  const messages: { parts: MessagePart[]; error?: string }[] = [];
  for (const [first, ...rest] of split.messages) {
    if (first?.type !== "text" || first.value.length <= 10_000) {
      messages.push({ parts: first ? [first, ...rest] : rest });
      continue;
    }
    const chunks = first.value.match(/[\s\S]{1,10000}/gu) ?? [];
    for (const [index, chunk] of chunks.entries()) {
      messages.push({ parts: [{ type: "text", value: chunk }, ...(index === chunks.length - 1 ? rest : [])] });
    }
  }
  if (split.error && messages[0]) messages[0].error = split.error;
  return messages;
};

class ChatSession {
  readonly process: PiProcess;
  readonly lines: AsyncIterator<string>;
  settled = false;
  private nextId = 0;
  constructor(process: PiProcess) { this.process = process; this.lines = process.stdout[Symbol.asyncIterator](); }
  async read(timeoutMs: number, signal?: AbortSignal): Promise<RpcRecord> {
    if (signal?.aborted) throw new Error("Pi RPC request aborted");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        this.lines.next(),
        new Promise<IteratorResult<string>>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Pi RPC request timed out")), timeoutMs);
          onAbort = () => reject(new Error("Pi RPC request aborted"));
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (result.done) throw new Error("Pi RPC process exited");
      const record = JSON.parse(result.value) as RpcRecord;
      if (record.type === "agent_settled") this.settled = true;
      return record;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
  async command(type: string, data: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<RpcRecord> {
    const id = String(++this.nextId);
    this.process.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    for (;;) {
      const record = await this.read(timeoutMs, signal);
      if (record.type === "response" && record.id === id) {
        if (record.success === false) throw new Error(record.error ?? `Pi RPC ${type} failed`);
        return record;
      }
    }
  }
  stop(): void { this.process.stdin.end(); this.process.kill(); }
}
export class PiChannel {
  readonly #relay: Relay;
  readonly #options: PiChannelOptions;
  readonly #spawnPi: (command: string, args: readonly string[], chatId: string) => PiProcess;
  readonly #sessions = new Map<string, ChatSession>();
  readonly #turns = new Map<string, Promise<void>>();
  readonly #seen = new Set<string>();
  readonly #inflight = new Map<string, Promise<void>>();
  #abortListener?: () => void;
  constructor(options: PiChannelOptions) {
    if (!options.agentToken.trim()) throw new Error("Relay Agent Token is required");
    this.#options = options;
    this.#relay = options.relay ?? new Relay({ apiKey: options.agentToken, ...(options.baseURL ? { baseURL: options.baseURL } : {}) });
    this.#spawnPi = options.spawnPi ?? ((command, args) => new ChildPiProcess(command, args));
  }
  async run(signal?: AbortSignal): Promise<void> {
    this.#abortListener = () => this.stop();
    signal?.addEventListener("abort", this.#abortListener, { once: true });
    try {
      await this.#relay.websocket.run({ ...(signal ? { signal } : {}), onEvent: async (event) => this.#handle(event, signal), onFullSync: async () => { throw new Error("Pi channel cannot acknowledge FULL sync without a durable Relay inbox"); } });
    } finally {
      this.stop();
      if (signal) signal.removeEventListener("abort", this.#abortListener!);
    }
  }
  stop(): void { for (const session of this.#sessions.values()) session.stop(); this.#sessions.clear(); }
  async #handle(event: RelayWebhookEvent, signal?: AbortSignal): Promise<void> {
    if (this.#seen.has(event.event_id)) return;
    const message = textFromEvent(event);
    if (!message) return;
    const data = event.data as MessageWebhookData;
    this.#seen.add(event.event_id);
    const prior = this.#turns.get(data.chat.id) ?? Promise.resolve();
    const turn = prior.then(() => this.#runTurn(event, message, signal));
    this.#turns.set(data.chat.id, turn.catch(() => undefined));
    this.#inflight.set(event.event_id, turn);
    try { await turn; } catch (error) { this.#seen.delete(event.event_id); throw error; } finally { this.#inflight.delete(event.event_id); }
  }
  async #runTurn(event: RelayWebhookEvent, message: string, signal?: AbortSignal): Promise<void> {
    const data = event.data as MessageWebhookData;
    let session = this.#sessions.get(data.chat.id);
    if (!session) { session = new ChatSession(this.#spawnPi(this.#options.piCommand ?? "pi", ["--mode", "rpc", ...(this.#options.piArgs ?? [])], data.chat.id)); this.#sessions.set(data.chat.id, session); }
    const timeout = this.#options.rpcTimeoutMs ?? 60_000;
    await session.command("prompt", { message: piPrompt(message) }, timeout, signal);
    if (!session.settled) { while (!session.settled) await session.read(timeout, signal); }
    const response = await session.command("get_last_assistant_text", {}, timeout, signal);
    const answer = response.data?.text?.trim();
    if (!answer) throw new Error("Pi returned no final text answer");
    const messages = answerMessages(answer);
    if (messages[0]?.error) console.error(`Relay: the buttons block in pi's answer was left as text: ${messages[0].error}.`);
    for (const [index, message] of messages.entries()) await this.#relay.chats.messages.send(data.chat.id, { message: { parts: message.parts, idempotency_key: `pi-${event.event_id}-${index}` } });
  }
}
export const runPiChannel = (options: PiChannelOptions, signal?: AbortSignal): Promise<void> => new PiChannel(options).run(signal);
