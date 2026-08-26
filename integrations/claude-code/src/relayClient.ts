/**
 * Minimal Relay HTTP client for the channel server. Speaks the /v1 agent
 * surface only: GET /v1/events, POST /v1/messages, and GET /v1/agents/me.
 * Self-contained on purpose: the installed plugin has no sibling-package
 * runtime dependency.
 */

import type { PollEventsResponse, SendMessageBody } from "./types.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Canonicalize and validate the credential destination. Bearer tokens are
 * only sent to HTTPS origins; plain HTTP is allowed solely for a loopback
 * development server. Paths, query strings, fragments, and embedded
 * credentials are rejected so two spellings cannot name one origin.
 */
export function normalizeRelayBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RELAY_BASE_URL must be an absolute URL");
  }
  if (url.username || url.password) {
    throw new Error("RELAY_BASE_URL must not contain credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("RELAY_BASE_URL must be an origin without a path, query, or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error("RELAY_BASE_URL must use HTTPS (HTTP is allowed only for loopback development)");
  }
  return url.origin;
}

export class RelayApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RelayApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RelayClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class RelayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RelayClientOptions) {
    this.baseUrl = normalizeRelayBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private async parseError(response: Response): Promise<RelayApiError> {
    let code = "http_error";
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body; keep the status line.
    }
    return new RelayApiError(response.status, code, message);
  }

  /**
   * Long-polls GET /v1/events for everything after `after`. Resolves with an
   * empty batch on server-side timeout. The fetch itself is aborted at
   * timeoutSeconds + 15s so a hung connection cannot wedge the loop.
   *
   * A plain pull: no exclusive consumer, no acknowledgement handshake, and it
   * coexists with a webhook. Delivery is at least once, so an event seen
   * before is ignored rather than reconciled.
   */
  async pollEvents(params: {
    after: number;
    timeoutSeconds?: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<PollEventsResponse> {
    const timeoutSeconds = params.timeoutSeconds ?? 25;
    const url = new URL(`${this.baseUrl}/v1/events`);
    url.searchParams.set("after", String(params.after));
    url.searchParams.set("timeout", String(timeoutSeconds));
    url.searchParams.set("limit", String(params.limit ?? 100));

    const signals: AbortSignal[] = [AbortSignal.timeout((timeoutSeconds + 15) * 1000)];
    if (params.signal) signals.push(params.signal);
    const response = await this.fetchImpl(url, {
      headers: this.headers(),
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) throw await this.parseError(response);
    const body = (await response.json()) as Partial<PollEventsResponse>;
    const nextCursor =
      typeof body.next_cursor === "number" ? body.next_cursor : params.after;
    return {
      events: Array.isArray(body.events) ? body.events : [],
      next_cursor: nextCursor,
      latest: typeof body.latest === "number" ? body.latest : nextCursor,
      has_more: body.has_more === true,
    };
  }

  /**
   * POST /v1/messages. The body's `message_id` is the whole idempotency
   * mechanism: replaying it returns the message it already committed, so
   * there is no key header to send.
   */
  async sendMessage(body: SendMessageBody): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw await this.parseError(response);
    return response.json();
  }

  /** GET /v1/agents/me — used by /relay:configure to verify the token. */
  async getMe(): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/agents/me`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw await this.parseError(response);
    return response.json();
  }
}
