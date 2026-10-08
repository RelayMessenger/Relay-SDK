import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import Relay, {
  BUTTONS_BLOCK_INSTRUCTION,
  BUTTONS_GUIDANCE,
  PAYMENT_BLOCK_INSTRUCTION,
  PAYMENT_GUIDANCE,
  replyTargetContext,
  selectionReply,
  locationContext,
  selectionReplyContext,
  SELECTION_GUIDANCE,
  SELECTION_BLOCK_INSTRUCTION,
  LINK_LINE_INSTRUCTION,
  FORM_BLOCK_INSTRUCTION,
  FORM_GUIDANCE,
  RATING_REQUEST_BLOCK_INSTRUCTION,
  RATING_REQUEST_GUIDANCE,
  CARD_BLOCK_INSTRUCTION,
  CARD_GUIDANCE,
  PLACE_BLOCK_INSTRUCTION,
  answerMessages as splitAnswer,
  createPaymentPart,
  RelayAPIError,
  type MessagePart,
  type PaymentRequestCreateParams,
  type MessageWebhookData,
  type RelayWebhookEvent,
} from "@relaymessenger/sdk";

/**
 * A dialog one of the person's own Pi extensions opened with `ctx.ui.select`
 * or `ctx.ui.confirm`, the way Pi asks before a tool runs: Pi has "No
 * permission popups" and leaves confirmation flows to extensions (Pi README;
 * examples/extensions/permission-gate.ts). In RPC mode each one arrives as an
 * `extension_ui_request` and waits for an `extension_ui_response` (Pi
 * docs/rpc.md, "Extension UI Protocol").
 */
export interface PiDialog {
  readonly method: "select" | "confirm";
  readonly title: string;
  readonly message?: string;
  /** What the person picks from: the select's options, or Yes and No for a confirm. */
  readonly options: readonly string[];
  /** Pi's own wait: "the agent-side will auto-resolve with a default value when the timeout expires". */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Who answers Pi's dialogs, and reads the taps that answer them. */
export interface PiApprovals {
  /** The option picked, or undefined for no answer. */
  dialog(request: PiDialog): Promise<string | undefined>;
  /** Whether this event answered a dialog, so it starts no turn. */
  take(event: RelayWebhookEvent): Promise<boolean>;
}

/** A confirm's two options. */
export const CONFIRM_OPTIONS = ["Yes", "No"] as const;

export interface PiChannelOptions {
  readonly agentToken: string;
  readonly baseURL?: string;
  readonly piCommand?: string;
  readonly piArgs?: readonly string[];
  readonly rpcTimeoutMs?: number;
  readonly spawnPi?: (command: string, args: readonly string[], chatId: string) => PiProcess;
  readonly relay?: Relay;
  /**
   * Answers the person's own extensions' dialogs. Without it, a dialog is
   * dismissed at once (`cancelled: true`), so the extension gets its own
   * "no answer" and the turn goes on.
   */
  readonly approvals?: PiApprovals;
}
export interface PiProcess {
  readonly stdin: { write(data: string): void; end(): void };
  readonly stdout: AsyncIterable<string>;
  readonly kill: () => void;
}
interface RpcRecord {
  readonly type?: string; readonly id?: string; readonly success?: boolean; readonly data?: { text?: string | null }; readonly error?: string;
  /** `extension_ui_request` fields (Pi docs/rpc.md). */
  readonly method?: string; readonly title?: string; readonly message?: string; readonly options?: unknown; readonly timeout?: unknown;
  /** `tool_execution_start` fields (Pi docs/rpc.md). */
  readonly toolName?: string; readonly args?: { action?: unknown };
}

/** The `extension_ui_response` to one dialog request, from the option picked. */
export const dialogResponse = (record: Pick<RpcRecord, "id" | "method">, picked: string | undefined): Record<string, unknown> => {
  if (picked === undefined) return { type: "extension_ui_response", id: record.id, cancelled: true };
  if (record.method === "confirm") return { type: "extension_ui_response", id: record.id, confirmed: picked === CONFIRM_OPTIONS[0] };
  return { type: "extension_ui_response", id: record.id, value: picked };
};

/** A dialog request as `PiDialog`, or undefined for a method a card cannot answer (input, editor, fire-and-forget). */
export const piDialog = (record: RpcRecord): Omit<PiDialog, "signal"> | undefined => {
  if (record.type !== "extension_ui_request" || typeof record.id !== "string") return undefined;
  const timeoutMs = typeof record.timeout === "number" && record.timeout > 0 ? record.timeout : undefined;
  const base = { title: typeof record.title === "string" ? record.title : "", ...(typeof record.message === "string" ? { message: record.message } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  if (record.method === "confirm") return { method: "confirm", options: CONFIRM_OPTIONS, ...base };
  if (record.method === "select" && Array.isArray(record.options) && record.options.every((option) => typeof option === "string") && record.options.length) {
    return { method: "select", options: record.options as string[], ...base };
  }
  return undefined;
};

/** The dialog methods that wait for an answer (Pi docs/rpc.md). */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
/** The variable naming the chat a Pi was started for, read by the extension's Relay tools. */
export const RELAY_CHAT_ID_ENV = "RELAY_PI_CHAT_ID";
/**
 * The environment of the Pi started for one chat: this process's, plus the
 * chat, the token and the API origin, so the extension's Relay tools act on
 * that chat.
 */
export const piEnv = (options: Pick<PiChannelOptions, "agentToken" | "baseURL">, chatId: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...base,
  [RELAY_CHAT_ID_ENV]: chatId,
  RELAY_AGENT_TOKEN: options.agentToken,
  ...(options.baseURL ? { RELAY_BASE_URL: options.baseURL } : {}),
});
class ChildPiProcess implements PiProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  constructor(command: string, args: readonly string[], env: NodeJS.ProcessEnv) { this.#child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env }); this.#child.stderr.resume(); }
  get stdin() { return this.#child.stdin; }
  get stdout() { return createInterface({ input: this.#child.stdout }); }
  kill = () => { this.#child.kill(); };
}
/**
 * The words of one inbound Message as Pi reads them: its text and links, then
 * the data of a pin or location share, then what a selection answers. Empty
 * for a Message with none, such as a photo alone.
 */
export const wordsOf = (data: MessageWebhookData): string => {
  // A pin and a location share have no words; their data follows the words.
  const text = [
    data.parts
      .flatMap((part) => part.type === "text" || part.type === "link" ? [part.value] : [])
      .join("\n").trim(),
    locationContext(data.parts),
  ].filter(Boolean).join("\n\n");
  const context = selectionReplyContext(selectionReply(data.parts, data.reply_to), {
    parts: data.parts, ...(data.reply_to ? { reply_to: data.reply_to } : {}),
  });
  return [text, context].filter(Boolean).join("\n\n");
};
const textFromEvent = (event: RelayWebhookEvent): string | null => {
  if (event.event_type !== "message.received" || event.data.direction !== "inbound") return null;
  // A sender with no Handle is skipped.
  if (!event.data.sender_handle) return null;
  return wordsOf(event.data) || null;
};
/**
 * The prompt pi is given for one message: the words, then how to answer.
 * This process sends pi's final text for it, and the same buttons and link
 * rules every other runtime carries.
 */
export const piPrompt = (message: string): string =>
  `${message}\n\nWrite your answer as your final message: Relay sends that answer to the chat for you. Or text the person yourself with the message tool, then end with no text so nothing is sent twice. To stay silent, end with no text: nothing is sent. Write chat text. Inline Markdown draws: bold, italic, strikethrough, code, links. Headings, lists and code fences show as written.\n\n${BUTTONS_BLOCK_INSTRUCTION} ${LINK_LINE_INSTRUCTION} ${BUTTONS_GUIDANCE} ${SELECTION_BLOCK_INSTRUCTION} ${SELECTION_GUIDANCE} ${FORM_BLOCK_INSTRUCTION} ${FORM_GUIDANCE} ${CARD_BLOCK_INSTRUCTION} ${CARD_GUIDANCE} ${PLACE_BLOCK_INSTRUCTION} ${PAYMENT_BLOCK_INSTRUCTION} ${PAYMENT_GUIDANCE} ${RATING_REQUEST_BLOCK_INSTRUCTION} ${RATING_REQUEST_GUIDANCE}${RELAY_TOOLS_LINE}`;

/**
 * The Relay tools the Pi extension registers when Relay starts it for a chat
 * (`message`, `relay_request_location`, `relay_read_location`), and the reply tags OpenClaw's channels read
 * (docs/reference/rich-output-protocol.md: `[[reply_to_current]]`,
 * `[[reply_to:<id>]]`).
 */
export const RELAY_TOOLS_LINE =
  " In a one-to-one chat, relay_request_location asks the person to share their location and relay_read_location reads where everyone sharing is now. message texts the person now (action send), reacts to a Message with an emoji (react), or sends a file from this machine (file). Each Message names its Relay message id; to thread your answer to a Message, put [[reply_to_current]] (the Message you are answering) or [[reply_to:<id>]] in it: the tag is removed and not shown.";

/** The id of the Message being answered, as one line of data the Relay tools and reply tags can name. */
export const messageIdLine = (data: Pick<MessageWebhookData, "id">): string => data.id ? `[Relay message id: ${data.id}]` : "";

const REPLY_TAG = /\[\[\s*reply_to(?:_current|\s*:\s*([^\]\s]+))\s*\]\]/gu;

/**
 * An answer's reply tag: the words without any `[[reply_to_current]]` or
 * `[[reply_to:<id>]]`, and the Message the first one names (`current` for the
 * Message being answered). No tag leaves the words as they are.
 */
export const replyTag = (answer: string): { answer: string; replyTo?: string } => {
  const first = [...answer.matchAll(REPLY_TAG)][0];
  if (!first) return { answer };
  return { answer: answer.replace(REPLY_TAG, "").replace(/[ \t]+\n/gu, "\n").trim(), replyTo: first[1] ?? "current" };
};

/**
 * The messages an answer becomes: each link written alone on a line as its
 * own message, text in chunks the API takes, and the buttons its fenced block
 * asked for under the last words. A block pi wrote that cannot be read stays
 * in the words, so nothing the person was told is lost.
 */
export const answerMessages = (answer: string): { parts: MessagePart[]; error?: string; payment?: PaymentRequestCreateParams }[] => {
  const split = splitAnswer(answer);
  const messages: { parts: MessagePart[]; error?: string; payment?: PaymentRequestCreateParams }[] = [];
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
  // The payment request the block described: created with the card's own key
  // and sent as the last Message.
  if (split.payment) messages.push({ parts: [], payment: split.payment });
  return messages;
};

class ChatSession {
  readonly process: PiProcess;
  readonly lines: AsyncIterator<string>;
  settled = false;
  /** Whether Pi texted the chat itself with `message` since the last prompt, so its final text is not sent again. */
  texted = false;
  private nextId = 0;
  /** Dialogs waiting on a person; Pi is silent meanwhile, which is not a stall. */
  private dialogs = 0;
  readonly #approvals: PiApprovals | undefined;
  readonly #stop = new AbortController();
  constructor(process: PiProcess, approvals?: PiApprovals) {
    this.process = process;
    this.lines = process.stdout[Symbol.asyncIterator]();
    this.#approvals = approvals;
  }
  /** Answers one dialog without holding up the reading of Pi's output. */
  #answer(record: RpcRecord): void {
    const dialog = piDialog(record);
    const reply = (picked: string | undefined): void => {
      try { this.process.stdin.write(`${JSON.stringify(dialogResponse(record, picked))}\n`); } catch { /* Pi is gone. */ }
    };
    if (!dialog || !this.#approvals) { reply(undefined); return; }
    this.dialogs += 1;
    void this.#approvals.dialog({ ...dialog, signal: this.#stop.signal })
      .catch(() => undefined)
      .then((picked) => { reply(picked); })
      .finally(() => { this.dialogs -= 1; });
  }
  async read(timeoutMs: number, signal?: AbortSignal): Promise<RpcRecord> {
    if (signal?.aborted) throw new Error("Pi RPC request aborted");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        this.lines.next(),
        new Promise<IteratorResult<string>>((_, reject) => {
          const expire = (): void => {
            if (this.dialogs > 0) { timer = setTimeout(expire, timeoutMs); return; }
            reject(new Error("Pi RPC request timed out"));
          };
          timer = setTimeout(expire, timeoutMs);
          onAbort = () => reject(new Error("Pi RPC request aborted"));
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (result.done) throw new Error("Pi RPC process exited");
      const record = JSON.parse(result.value) as RpcRecord;
      if (record.type === "agent_settled") this.settled = true;
      if (record.type === "tool_execution_start" && record.toolName === "message" && record.args?.action === "send") this.texted = true;
      if (record.type === "extension_ui_request" && DIALOG_METHODS.has(String(record.method))) this.#answer(record);
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
  stop(): void { this.#stop.abort(); this.process.stdin.end(); this.process.kill(); }
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
    this.#spawnPi = options.spawnPi ?? ((command, args, chatId) => new ChildPiProcess(command, args, piEnv(options, chatId)));
  }
  async run(signal?: AbortSignal): Promise<void> {
    this.#abortListener = () => this.stop();
    signal?.addEventListener("abort", this.#abortListener, { once: true });
    try {
      await this.#relay.websocket.run({ ...(signal ? { signal } : {}), onEvent: async (event) => { if (await this.#options.approvals?.take(event)) return; await this.#handle(event, signal); }, onFullSync: async () => { throw new Error("Pi channel cannot acknowledge FULL sync without a durable Relay inbox"); } });
    } finally {
      this.stop();
      if (signal) signal.removeEventListener("abort", this.#abortListener!);
    }
  }
  stop(): void { for (const session of this.#sessions.values()) session.stop(); this.#sessions.clear(); }
  async #handle(event: RelayWebhookEvent, signal?: AbortSignal): Promise<void> {
    // Concurrent redelivery must await the original handoff, not ACK early.
    const inflight = this.#inflight.get(event.event_id);
    if (inflight) return inflight;
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
    if (!session) { session = new ChatSession(this.#spawnPi(this.#options.piCommand ?? "pi", ["--mode", "rpc", ...(this.#options.piArgs ?? [])], data.chat.id), this.#options.approvals); this.#sessions.set(data.chat.id, session); }
    const timeout = this.#options.rpcTimeoutMs ?? 60_000;
    const replyLine = await repliedContext(this.#relay, data);
    // The person sees Pi typing while it works; it stops once the answer is sent.
    await typing(this.#relay, data.chat.id, true);
    session.texted = false;
    try {
      await session.command("prompt", { message: piPrompt([message, replyLine, messageIdLine(data)].filter(Boolean).join("\n\n")) }, timeout, signal);
      if (!session.settled) { while (!session.settled) await session.read(timeout, signal); }
      const response = await session.command("get_last_assistant_text", {}, timeout, signal);
      const answer = response.data?.text?.trim();
      // No words is Pi's choice to stay silent, and a Pi that texted with
      // `message` has said it (OpenClaw didSendViaMessagingTool): nothing is sent.
      if (!answer || session.texted) return;
      await sendAnswer(this.#relay, data, `pi-${event.event_id}`, answer);
    } finally {
      await typing(this.#relay, data.chat.id, false);
    }
  }
}
/**
 * The Message a swipe-reply answers, as one line of data. Relay sends only the
 * pointer, as Telegram hands a bot `reply_to_message`, so it is read once; a
 * read that fails names the target by id instead. Empty for no reply.
 */
export const repliedContext = async (relay: Relay, data: MessageWebhookData): Promise<string> => {
  const replied = data.reply_to?.message_id ? data.reply_to : undefined;
  if (!replied) return "";
  return replyTargetContext(replied, await (async () => relay.messages.retrieve(replied.message_id))().catch(() => undefined));
};
/**
 * Sends Pi's answer to the chat the Message came from, as the Messages
 * `answerMessages` makes of it, each on `${key}-${index}`.
 */
export const sendAnswer = async (relay: Relay, data: MessageWebhookData, key: string, answer: string): Promise<void> => {
  // An answer to another agent replies to its Message, as a bot's reply
  // names the message it answers (Telegram `reply_parameters.message_id`), so
  // an agent that sent several knows which one it answers. A person's
  // Message is not named, so the chat looks as it always has. An agent may
  // not reply to buttons or a selection, and a reply names part 0.
  // Turns in one chat already run one after another, so an agent's two
  // messages each get their own answer.
  // A reply tag Pi wrote names the Message itself and wins.
  const opening = data.parts[0]?.type;
  const answerable = opening !== "buttons" && opening !== "selection";
  const replyTo = data.sender_handle?.kind === "agent" && answerable ? data.id : undefined;
  await sendToChat(relay, data.chat.id, key, answer, replyTo, answerable ? data.id : undefined);
};
/**
 * Sends an answer to one chat as the Messages `answerMessages` makes of it,
 * each on `${key}-${index}`; the first replies to `replyTo` when given. A
 * reply tag in the answer wins and is removed: `[[reply_to:<id>]]` names the
 * Message, `[[reply_to_current]]` names `current`, and no reply when there is
 * no current Message.
 */
export const sendToChat = async (relay: Relay, chatId: string, key: string, answer: string, replyTo?: string, current?: string): Promise<void> => {
  const tagged = replyTag(answer);
  const target = tagged.replyTo === undefined ? replyTo : tagged.replyTo === "current" ? current : tagged.replyTo;
  const messages = answerMessages(tagged.answer);
  if (messages[0]?.error) console.error(`Relay: the component block in pi's answer was left as text: ${messages[0].error}.`);
  for (const [index, message] of messages.entries()) {
    const messageKey = `${key}-${index}`;
    let parts = message.parts;
    if (message.payment) {
      try {
        parts = [await createPaymentPart(relay, message.payment, messageKey)];
      } catch (error) {
        if (!(error instanceof RelayAPIError) || error.retryable) throw error;
        console.error(`Relay: the payment in pi's answer was not sent: ${error.message}`);
        continue;
      }
    }
    await relay.chats.messages.send(chatId, { message: { parts, idempotency_key: messageKey, ...(index === 0 && target ? { reply_to: { message_id: target } } : {}) } });
  }
};
/**
 * Shows or clears Pi's typing indicator in a chat. It is a courtesy: a
 * failure is logged and the turn goes on.
 */
export const typing = (relay: Relay, chatId: string, on: boolean): Promise<void> =>
  Promise.resolve()
    .then(() => on ? relay.chats.startTyping(chatId) : relay.chats.stopTyping(chatId))
    .catch((error: unknown) => {
      console.error(`Relay: typing indicator failed: ${error instanceof Error ? error.message : String(error)}`);
    });
export const runPiChannel = (options: PiChannelOptions, signal?: AbortSignal): Promise<void> => new PiChannel(options).run(signal);
