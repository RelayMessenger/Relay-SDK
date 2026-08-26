/**
 * Compatibility facade over the canonical @relaymessenger/sdk client.
 *
 * The running bridge uses the SDK for identity, polling, messages, typing and
 * read receipts. This facade keeps the CLI's established positional
 * signatures and implements only the endpoints the SDK does not expose: the
 * Better Auth device-authorization flow that `relaymessenger pair` runs, agent
 * creation, and the conversation/history inventory.
 */
import {
  classifyRelayHttpStatus,
  createRelayClient,
  DEFAULT_RELAY_BASE_URL,
  normalizeRelayBaseUrl,
  RelayApiError,
  relayId,
  type RelayClient as SdkRelayClient,
  type RelayOutgoingPart as SdkRelayOutgoingPart,
} from "@relaymessenger/sdk";
import type {
  RelayEvent,
  RelayMention,
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

/** `POST /api/auth/device/code`. `expires_in` and `interval` are seconds. */
export interface DeviceCodeGrant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/**
 * One `POST /api/auth/device/token` outcome.
 *
 * Two error vocabularies reach this endpoint and neither is a superset of the
 * other: RFC 8628 states arrive as `{ error, error_description }`, while a
 * request Better Auth refuses before it reaches the grant arrives in Better
 * Auth's own `{ message, code }`. Which key is present is the discriminator.
 */
export type DeviceTokenResult =
  | {
      kind: "token";
      access_token: string;
      token_type: string;
      expires_in?: number;
      scope?: string;
    }
  | { kind: "oauth_error"; error: string; error_description?: string }
  | { kind: "request_error"; message: string; code?: string }
  /** A network blip or a 5xx: the grant is untouched, so keep polling. */
  | { kind: "transient"; message: string };

/** `POST /v1/me/agents` — the agent and the `rly_live_` key that drives it. */
export interface CreatedAgent {
  agent: {
    id?: string;
    handle?: string;
    displayName?: string;
    visibility?: string;
    [key: string]: unknown;
  };
  token: string;
  conversation_id?: string;
}

export interface NewAgentBody {
  handle: string;
  displayName: string;
  tagline?: string;
}

/**
 * One page of `GET /v1/events?after=N`. A plain pull: no exclusive consumer,
 * no acknowledgement handshake, nothing to reconcile.
 */
export interface EventsPage {
  events: RelayEvent[];
  /** Pass as `after` on the next poll. */
  next_cursor: number;
  /** The highest sequence Relay has issued to this agent. */
  latest: number;
  /** True when `next_cursor` is behind `latest` — poll again immediately. */
  has_more: boolean;
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
      mentions?: RelayMention[];
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
  /**
   * The `msg_` id this send commits under. It is the message's identity AND
   * the send's only retry key: the same id is a replay, a fresh one on retry
   * sends the message twice. Minted here when the caller has no durable id of
   * its own to reuse.
   */
  message_id?: string;
  parts: RelayOutgoingPart[];
  reply_to?: { message_id: string; part_id?: string };
}

/** One send is one message. */
export interface PostedMessage {
  message_id: string;
  message: RelayMessage;
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
   * The device flow, agent creation, and history inventory are not in the
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
    const { response, json, text } = await this.rawRequest(method, path, options);
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

  private async rawRequest(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      bearer?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<{ response: Response; json: unknown; text: string }> {
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
    return { response, json, text };
  }

  private authenticatedClient(): SdkRelayClient {
    if (!this.sdk) {
      throw new Error("relay: Agent API key is required");
    }
    return this.sdk;
  }

  /** RFC 8628 step 1: ask for a code the person can approve in the app. */
  requestDeviceCode(clientId: string, scope?: string): Promise<DeviceCodeGrant> {
    return this.compatibilityRequest("POST", "/api/auth/device/code", {
      body: { client_id: clientId, ...(scope ? { scope } : {}) },
    });
  }

  /**
   * RFC 8628 step 3. JSON only — the endpoint refuses a form-encoded body
   * with 415 — and every documented outcome is a value, not a throw: pending
   * is the expected steady state, so it must not travel as an exception.
   */
  async pollDeviceToken(deviceCode: string, clientId: string): Promise<DeviceTokenResult> {
    const { response, json, text } = await this.rawRequest(
      "POST",
      "/api/auth/device/token",
      {
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: clientId,
        },
      },
    );
    const body = (json ?? {}) as Record<string, unknown>;
    if (classifyRelayHttpStatus(response.status) === "retryable" && !response.ok) {
      return {
        kind: "transient",
        message: `device token request failed with ${response.status}`,
      };
    }
    if (response.ok && typeof body.access_token === "string") {
      return {
        kind: "token",
        access_token: body.access_token,
        token_type: typeof body.token_type === "string" ? body.token_type : "Bearer",
        ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
        ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      };
    }
    if (typeof body.error === "string") {
      return {
        kind: "oauth_error",
        error: body.error,
        ...(typeof body.error_description === "string"
          ? { error_description: body.error_description }
          : {}),
      };
    }
    return {
      kind: "request_error",
      message: typeof body.message === "string"
        ? body.message
        : text.slice(0, 300) || `device token request failed with ${response.status}`,
      ...(typeof body.code === "string" ? { code: body.code } : {}),
    };
  }

  /**
   * Create this machine's agent with the session the device flow returned.
   * The response carries the agent's `rly_live_` key, which is the only
   * credential the bridge keeps.
   */
  createAgent(sessionToken: string, body: NewAgentBody): Promise<CreatedAgent> {
    return this.compatibilityRequest("POST", "/v1/me/agents", {
      bearer: sessionToken,
      body,
    });
  }

  async getMe(): Promise<Record<string, unknown>> {
    return { agent: await this.authenticatedClient().getMe() };
  }

  async getEvents(after: number, timeoutS = 25, limit = 100): Promise<EventsPage> {
    const page = await this.authenticatedClient().pollEvents({
      after,
      timeoutSeconds: timeoutS,
      limit,
    });
    return {
      events: page.events as RelayEvent[],
      next_cursor: page.nextCursor,
      latest: page.latest,
      has_more: page.hasMore,
    };
  }

  async postMessage(body: PostMessageBody): Promise<PostedMessage> {
    const messageId = body.message_id ?? relayId("msg");
    const result = await this.authenticatedClient().sendMessage({
      conversationId: body.conversation_id,
      messageId,
      parts: body.parts as SdkRelayOutgoingPart[],
      ...(body.reply_to ? { replyTo: body.reply_to } : {}),
    });
    return { message_id: result.messageId, message: result.message as RelayMessage };
  }

  listConversations(limit = 50): Promise<{ conversations: RelayConversation[] }> {
    return this.compatibilityRequest(
      "GET",
      `/v1/conversations?limit=${encodeURIComponent(limit)}`,
    );
  }

  async listMessages(
    conversationId: string,
    limit = 20,
  ): Promise<{ messages: RelayMessage[] }> {
    const page = await this.authenticatedClient().getHistory({ conversationId, limit });
    return { messages: page.messages as RelayMessage[] };
  }

  /** Fire and forget: nothing is stored, no lease is taken. */
  setTyping(conversationId: string, started: boolean): Promise<void> {
    return this.authenticatedClient().setTyping({ conversationId, started });
  }

  async markRead(conversationId: string, messageId: string): Promise<void> {
    await this.authenticatedClient().markRead({ conversationId, messageId });
  }
}
