import type { RelayMessage, RelayOutgoingPart, SendResult } from "./types.js";
import { relayId } from "./ulid.js";

export interface RelayClientOptions {
  token: string;
  /** Defaults to Relay production. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface SendOptions {
  conversationId: string;
  parts: RelayOutgoingPart[];
  /**
   * The message's identity, minted client side. Omit and the client mints one.
   * Reuse the same id across retries of one logical send: that is the whole
   * idempotency mechanism, so minting a fresh one on a retry is how you send
   * the same message twice.
   */
  messageId?: string;
  replyTo?: { messageId: string; partId?: string };
  fallbackText?: string;
}

export interface TypingOptions {
  conversationId: string;
  started?: boolean;
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
 * SDK backend needs: sends keyed by a client-minted message id, and the
 * ephemeral typing indicator. Raw HTTPS remains the canonical contract; see
 * https://docs.relayapp.im/api-reference/overview.
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

  /**
   * `POST /v1/messages`. One send is one message, keyed by the `msg_` id the
   * client minted: Relay replays that id rather than committing it twice, and
   * refuses another sender's claim on it with 409. There is no idempotency
   * header.
   */
  async send(options: SendOptions): Promise<SendResult> {
    const messageId = options.messageId ?? relayId("msg");
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversation_id: options.conversationId,
        message_id: messageId,
        parts: options.parts,
        ...(options.replyTo
          ? {
              reply_to: {
                message_id: options.replyTo.messageId,
                ...(options.replyTo.partId ? { part_id: options.replyTo.partId } : {}),
              },
            }
          : {}),
        ...(options.fallbackText === undefined
          ? {}
          : { fallback_text: options.fallbackText }),
      }),
    });
    await raiseForStatus(response);
    const body = (await response.json()) as {
      message_id?: string;
      message?: RelayMessage;
    };
    if (!body.message) {
      throw new RelayApiError(
        502,
        "empty_send",
        "relay: 202 carried no committed message",
      );
    }
    return { message_id: body.message_id ?? messageId, message: body.message };
  }

  async sendText(
    options: Omit<SendOptions, "parts"> & { text: string },
  ): Promise<SendResult> {
    const { text, ...rest } = options;
    return this.send({ ...rest, parts: [{ type: "text", text }] });
  }

  /**
   * Ephemeral typing indicator; never enters the event log. Fire and forget:
   * nothing is stored, no lease is taken, and the recipient's client hides the
   * indicator on its own. Send the start again while still composing to keep
   * it alive.
   */
  async typing(options: TypingOptions): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${options.conversationId}/typing`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ started: options.started ?? true }),
      },
    );
    await raiseForStatus(response);
  }
}
