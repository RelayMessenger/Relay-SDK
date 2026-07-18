/**
 * Thin client for the Relay public API (https://docs.relayapp.im).
 * Wire shapes follow docs/api-reference/openapi.yaml plus the pairing +
 * long-poll additions from plan/12-coding-agent-bridge.md §A.
 */
import type { RelayEvent, RelayMessage } from "./store.js";

export const PRODUCTION_ORIGIN = "https://api.relayapp.im";
export const STAGING_ORIGIN = "https://api.staging.relayapp.im";

export class RelayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RelayApiError";
  }
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
  | { status: "claimed"; agent_token: string; agent?: Record<string, unknown> };

export interface EventsPage {
  events: RelayEvent[];
  next_cursor: number;
}

export interface PostMessageBody {
  conversation_id: string;
  parts: Array<Record<string, unknown>>;
  suggestions?: Array<{ text: string }>;
  reply_to?: { message_id: string; part_index?: number };
}

export class RelayClient {
  constructor(
    readonly origin: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      bearer?: string;
      timeoutMs?: number;
      expectStatus?: number[];
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...opts.headers };
    const bearer = opts.bearer ?? this.token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(`${this.origin}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const okStatuses = opts.expectStatus ?? [200, 201, 202, 204];
    if (!okStatuses.includes(res.status)) {
      const code = json?.error?.code ?? json?.code;
      const message = json?.error?.message ?? json?.message ?? text.slice(0, 300) ?? res.statusText;
      throw new RelayApiError(res.status, code, `${method} ${path} → ${res.status}: ${message}`);
    }
    return json as T;
  }

  // — Pairing (unauthenticated create; poll_token bearer for polling) —

  createPairing(deviceName: string, engine?: string): Promise<PairingCreated> {
    return this.request("POST", "/v1/pairings", {
      body: { device_name: deviceName, ...(engine ? { engine } : {}) },
    });
  }

  waitPairing(pairingId: string, pollToken: string): Promise<PairingStatus> {
    return this.request("GET", `/v1/pairings/${pairingId}?wait=true`, {
      bearer: pollToken,
      timeoutMs: 45_000,
    });
  }

  // — Agent-authenticated surface —

  getMe(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/agents/me");
  }

  getEvents(cursor: number, timeoutS = 25, limit = 100): Promise<EventsPage> {
    const qs = `cursor=${cursor}&timeout=${timeoutS}&limit=${limit}`;
    return this.request("GET", `/v1/events?${qs}`, { timeoutMs: (timeoutS + 15) * 1000 });
  }

  postMessage(
    body: PostMessageBody,
    idempotencyKey: string,
  ): Promise<{ message_id: string; message: RelayMessage }> {
    return this.request("POST", "/v1/messages", {
      body,
      headers: { "idempotency-key": idempotencyKey },
    });
  }

  listMessages(conversationId: string, limit = 20): Promise<{ messages: RelayMessage[] }> {
    return this.request("GET", `/v1/conversations/${conversationId}/messages?limit=${limit}`);
  }

  setTyping(conversationId: string, started: boolean, label?: string): Promise<void> {
    return this.request("POST", `/v1/conversations/${conversationId}/typing`, {
      body: { started, ...(label ? { label } : {}) },
    });
  }

  markRead(conversationId: string, messageId: string): Promise<void> {
    return this.request("POST", `/v1/conversations/${conversationId}/read`, {
      body: { message_id: messageId },
    });
  }
}
