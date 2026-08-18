export type RelayApiErrorKind = "auth" | "conflict" | "retryable" | "rejected";

/** Classified Relay API failure. `terminal` means retrying the same request cannot succeed. */
export class RelayApiError extends Error {
  readonly status: number | undefined;
  readonly kind: RelayApiErrorKind;
  readonly code: string | undefined;
  /** Structured `error.details` from the response body, e.g. `highest_delivered_cursor` on 422. */
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    params: {
      status?: number;
      kind: RelayApiErrorKind;
      code?: string;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "RelayApiError";
    this.status = params.status;
    this.kind = params.kind;
    this.code = params.code;
    this.details = params.details;
  }

  get terminal(): boolean {
    return this.kind !== "retryable";
  }

  get retryable(): boolean {
    return this.kind === "retryable";
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export function classifyRelayHttpStatus(status: number): RelayApiErrorKind {
  if (status === 401) return "auth";
  if (status === 409) return "conflict";
  if (status === 408 || status === 429 || status >= 500) return "retryable";
  return "rejected";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function isRelayWebhookConflict(error: unknown): error is RelayApiError {
  return (
    error instanceof RelayApiError &&
    error.status === 409 &&
    error.code !== "terminated_by_other_consumer"
  );
}
