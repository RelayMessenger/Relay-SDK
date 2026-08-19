import type {
  RelayOutgoingPart,
  SendResult,
  StreamSendResult,
  UIMessageStreamSource,
} from "./types.js";

export interface RelayClientOptions {
  token: string;
  /** Defaults to Relay production. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface SendOptions {
  conversationId: string;
  parts: RelayOutgoingPart[];
  idempotencyKey: string;
  invocationId?: string;
  replyTo?: { messageId: string };
}

export interface StreamOptions {
  conversationId: string;
  /**
   * A Vercel AI SDK UI message stream: chunk objects from
   * `toUIMessageStream(...)`, already-encoded SSE bytes, an SSE `Response`,
   * or a legacy `toUIMessageStreamResponse()` result.
   */
  stream: UIMessageStreamSource;
  idempotencyKey: string;
  invocationId?: string;
  replyTo?: { messageId: string };
}

export interface TypingOptions {
  conversationId: string;
  started?: boolean;
  label?: string;
  invocationId?: string;
}

export class RelayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayApiError";
  }
}

const DEFAULT_BASE_URL = "https://api.relayapp.im";

/**
 * SSE-encode a stream of UI message chunk objects, byte-for-byte what ai@7's
 * `createUIMessageStreamResponse` writes: `data: <json>\n\n` per chunk and a
 * final `data: [DONE]\n\n` (ai 7.0.66 dist/index.js:6459-6471, 6485-6503).
 *
 * The same stream type carries both already-encoded SSE bytes and chunk
 * objects, so the mode is decided from the FIRST chunk and then fixed for the
 * life of the stream: an `ArrayBuffer` view means bytes, anything else means
 * objects. A byte stream is forwarded untouched and gets no terminator
 * appended, because whoever encoded it already wrote one.
 */
function encodeUIMessageStream(
  source: ReadableStream<unknown>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const encoder = new TextEncoder();
  let bytesMode: boolean | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // The object path owns the terminator. An empty stream never chose a
        // mode, so it terminates too: whoever produced zero chunks also wrote
        // zero terminators, and the server must not wait on a bare body.
        if (bytesMode !== true) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
        return;
      }
      bytesMode ??= ArrayBuffer.isView(value);
      if (bytesMode) {
        controller.enqueue(value as Uint8Array);
        return;
      }
      // JSON.stringify returns undefined for undefined/functions/symbols,
      // which would put invalid `data: undefined` frames on the wire.
      const json = JSON.stringify(value) ?? "null";
      controller.enqueue(encoder.encode(`data: ${json}\n\n`));
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function streamBody(source: UIMessageStreamSource): ReadableStream<Uint8Array> {
  if (source instanceof ReadableStream) return encodeUIMessageStream(source);
  const response =
    source instanceof Response ? source : source.toUIMessageStreamResponse();
  if (!response.body) {
    throw new Error("UI message stream response has no body");
  }
  return response.body;
}

async function raiseForStatus(response: Response): Promise<void> {
  if (response.ok) return;
  let code = "unknown";
  let message = `${response.status}`;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // non-JSON error body; keep the status text
  }
  throw new RelayApiError(response.status, code, message);
}

/**
 * Minimal Relay v1 client covering exactly what a webhook-driven Vercel AI
 * SDK backend needs: idempotent sends, one-shot UI-message-stream commits,
 * and the ephemeral typing indicator. Raw HTTPS remains the canonical
 * contract; see https://docs.relayapp.im/api-reference/overview.
 */
export class RelayClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RelayClientOptions) {
    if (!options.token) throw new Error("Relay Agent Token is required");
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async send(options: SendOptions): Promise<SendResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey,
      },
      body: JSON.stringify({
        conversation_id: options.conversationId,
        parts: options.parts,
        ...(options.invocationId ? { invocation_id: options.invocationId } : {}),
        ...(options.replyTo
          ? { reply_to: { message_id: options.replyTo.messageId } }
          : {}),
      }),
    });
    await raiseForStatus(response);
    return (await response.json()) as SendResult;
  }

  async sendText(
    options: Omit<SendOptions, "parts"> & { text: string },
  ): Promise<SendResult> {
    const { text, ...rest } = options;
    return this.send({ ...rest, parts: [{ type: "text", text }] });
  }

  /**
   * Forward a Vercel AI SDK UI message stream to Relay in one request.
   * Relay consumes the whole stream and commits one or more finished
   * messages, one per bubble; there are no draft bubbles to clean up.
   */
  async stream(options: StreamOptions): Promise<StreamSendResult> {
    const query = new URLSearchParams({
      stream: "true",
      conversation_id: options.conversationId,
    });
    if (options.invocationId) query.set("invocation_id", options.invocationId);
    if (options.replyTo) {
      query.set("reply_to", options.replyTo.messageId);
    }
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/messages?${query}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "text/event-stream",
          "Idempotency-Key": options.idempotencyKey,
          "x-vercel-ai-ui-message-stream": "v1",
        },
        body: streamBody(options.stream),
        // Node's fetch requires half-duplex for streamed request bodies.
        duplex: "half",
      } as RequestInit,
    );
    await raiseForStatus(response);
    return (await response.json()) as StreamSendResult;
  }

  /** Ephemeral typing indicator; never enters the event log. */
  async typing(options: TypingOptions): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${options.conversationId}/typing`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          started: options.started ?? true,
          ...(options.label ? { label: options.label } : {}),
          ...(options.invocationId
            ? { invocation_id: options.invocationId }
            : {}),
        }),
      },
    );
    await raiseForStatus(response);
  }
}
