/**
 * Compatibility facade over the canonical @relaymessenger/sdk client.
 *
 * The running bridge uses the SDK for identity, polling, messages, typing,
 * responding, and read receipts. This facade keeps the CLI's established
 * positional signatures and implements only pairing and cursor-recovery
 * endpoints that the current published SDK does not expose.
 */
import {
  classifyRelayHttpStatus,
  createRelayClient,
  DEFAULT_RELAY_BASE_URL,
  normalizeRelayBaseUrl,
  RelayApiError,
  type RelayClient as SdkRelayClient,
  type RelayOutgoingPart as SdkRelayOutgoingPart,
} from "@relaymessenger/sdk";
import type {
  RelayEvent,
  RelayMentionRange,
  RelayMessage,
  RelayStyleRange,
} from "./store.js";

export { RelayApiError };

export const PRODUCTION_ORIGIN = DEFAULT_RELAY_BASE_URL;
export const normalizeApiOrigin = normalizeRelayBaseUrl;

/**
 * Development/testing override for the Relay API origin. Production stays the
 * default. The SDK owns all URL validation.
 */
export function resolveApiOrigin(fallback: string = PRODUCTION_ORIGIN): string {
  const override = process.env.RELAY_API_ORIGIN?.trim();
  return normalizeRelayBaseUrl(override || fallback);
}

export interface PairingCreated {
  pairing_id: string;
  code: string;
  url: string;
  poll_token: string;
  expires_in: number;
}

export type PairingStatus =
  | { status: "pending" }
  | {
      status: "claimed";
      agent_token: string;
      agent?: Record<string, unknown>;
    };

export interface EventsPage {
  events: RelayEvent[];
  next_cursor: number;
}

export interface EventCursorReconciliation {
  reconciled: true;
  resume_cursor: number;
}

export interface RelayConversation {
  id: string;
  kind?: "direct" | "group";
  last_sequence?: number;
  last_message_at?: string | null;
}

export type RelayOutgoingPart =
  | {
      type: "text";
      text: string;
      mentions?: RelayMentionRange[];
      styles?: RelayStyleRange[];
    }
  | {
      type: "media";
      attachment_id?: string;
      url?: string;
      width?: number;
      height?: number;
      blur_hash?: string;
    }
  | {
      type: "voice_memo";
      attachment_id?: string;
      url?: string;
      duration_ms?: number;
    }
  | { type: "link_preview"; url: string }
  | { type: "data"; data: Record<string, unknown> };

export interface PostMessageBody {
  conversation_id: string;
  parts: RelayOutgoingPart[];
  reply_to?: { message_id: string };
  /**
   * Required in a group: Relay supplies this on the inbound invocation and
   * consumes it when the reply commits.
   */
  invocation_id?: string;
}

export class RelayClient {
  readonly origin: string;
  private readonly sdk: SdkRelayClient | undefined;

  constructor(
    origin: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.origin = normalizeRelayBaseUrl(origin);
    this.sdk = token
      ? createRelayClient({
          baseUrl: this.origin,
          token,
          fetchImpl,
          requestTimeoutMs: 30_000,
        })
      : undefined;
  }

  /**
   * Pairing, event reconciliation, and history inventory are not yet in the
   * published SDK. Keep their transport narrow until generated SDK methods
   * replace this compatibility path.
   */
  private async compatibilityRequest<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      bearer?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    const bearer = options.bearer ?? this.token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const envelope = json as {
        error?: {
          code?: string;
          message?: string;
          details?: Record<string, unknown>;
        };
        code?: string;
        message?: string;
      } | undefined;
      const code = envelope?.error?.code ?? envelope?.code;
      const message =
        envelope?.error?.message ??
        envelope?.message ??
        text.slice(0, 300) ??
        response.statusText;
      const details = envelope?.error?.details;
      throw new RelayApiError(
        `${method} ${path} → ${response.status}: ${message}`,
        {
          status: response.status,
          kind: classifyRelayHttpStatus(response.status),
          ...(code ? { code } : {}),
          ...(details ? { details } : {}),
        },
      );
    }
    return json as T;
  }

  private authenticatedClient(): SdkRelayClient {
    if (!this.sdk) {
      throw new Error("relay: Agent Token is required");
    }
    return this.sdk;
  }

  createPairing(deviceName: string, engine?: string): Promise<PairingCreated> {
    return this.compatibilityRequest("POST", "/v1/pairings", {
      body: {
        device_name: deviceName,
        ...(engine ? { engine } : {}),
      },
    });
  }

  waitPairing(pairingId: string, pollToken: string): Promise<PairingStatus> {
    return this.compatibilityRequest(
      "GET",
      `/v1/pairings/${encodeURIComponent(pairingId)}?wait=true`,
      { bearer: pollToken, timeoutMs: 45_000 },
    );
  }

  async getMe(): Promise<Record<string, unknown>> {
    return { agent: await this.authenticatedClient().getMe() };
  }

  async getEvents(cursor: number, timeoutS = 25, limit = 100): Promise<EventsPage> {
    const page = await this.authenticatedClient().pollEvents({
      cursor,
      timeoutSeconds: timeoutS,
      limit,
    });
    return {
      events: page.events as RelayEvent[],
      next_cursor: page.nextCursor,
    };
  }

  reconcileEvents(expiredCursor: number): Promise<EventCursorReconciliation> {
    return this.compatibilityRequest("POST", "/v1/events/reconcile", {
      body: {
        expired_cursor: expiredCursor,
        history_reconciled: true,
      },
      headers: {
        "idempotency-key": `event-cursor-reconcile:${expiredCursor}`,
      },
    });
  }

  postMessage(
    body: PostMessageBody,
    idempotencyKey: string,
  ): Promise<{ messages: RelayMessage[] }> {
    return this.authenticatedClient().sendMessage({
      conversationId: body.conversation_id,
      parts: body.parts as SdkRelayOutgoingPart[],
      idempotencyKey,
      ...(body.reply_to ? { replyTo: body.reply_to } : {}),
      ...(body.invocation_id ? { invocationId: body.invocation_id } : {}),
    }) as Promise<{ messages: RelayMessage[] }>;
  }

  listConversations(limit = 50): Promise<{ conversations: RelayConversation[] }> {
    return this.compatibilityRequest(
      "GET",
      `/v1/conversations?limit=${encodeURIComponent(limit)}`,
    );
  }

  listMessages(
    conversationId: string,
    limit = 20,
  ): Promise<{ messages: RelayMessage[] }> {
    return this.compatibilityRequest(
      "GET",
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=${encodeURIComponent(limit)}`,
    );
  }

  setTyping(
    conversationId: string,
    started: boolean,
    label?: string,
    invocationId?: string,
  ): Promise<void> {
    return this.authenticatedClient().setTyping({
      conversationId,
      started,
      ...(label ? { label } : {}),
      ...(invocationId ? { invocationId } : {}),
    });
  }

  setResponding(
    conversationId: string,
    messageId: string,
    label?: string,
    invocationId?: string,
  ): Promise<void> {
    return this.authenticatedClient().setResponding({
      conversationId,
      messageId,
      ...(label ? { label } : {}),
      ...(invocationId ? { invocationId } : {}),
    });
  }

  markRead(conversationId: string, messageId: string): Promise<void> {
    return this.authenticatedClient().markRead({ conversationId, messageId });
  }
}
