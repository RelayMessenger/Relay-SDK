export interface RelayAPIErrorOptions {
  status?: number;
  code?: number;
  traceId?: string;
  docURL?: string;
  retryAfter?: number;
  body?: unknown;
  cause?: unknown;
}

export class RelayAPIError extends Error {
  readonly status: number | undefined;
  readonly code: number | undefined;
  readonly traceId: string | undefined;
  readonly docURL: string | undefined;
  readonly retryAfter: number | undefined;
  readonly body: unknown;

  constructor(message: string, options: RelayAPIErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RelayAPIError";
    this.status = options.status;
    this.code = options.code;
    this.traceId = options.traceId;
    this.docURL = options.docURL;
    this.retryAfter = options.retryAfter;
    this.body = options.body;
  }

  get retryable(): boolean {
    return this.status === undefined
      || this.status === 408
      || this.status === 429
      || this.status >= 500;
  }
}

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";
