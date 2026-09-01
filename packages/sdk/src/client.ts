import { RelayAPIError, isAbortError } from "./errors.js";
import { ChatsPage, MessagesPage } from "./pagination.js";
import type {
  AcceptedResponse,
  Attachment,
  AttachmentCreateParams,
  AttachmentCreateResponse,
  BlockedHandleListResponse,
  BlockHandleParams,
  BlockHandleResponse,
  Chat,
  ChatCreateParams,
  ChatCreateResponse,
  ChatListChatsParams,
  ChatSendVoicememoParams,
  ChatSendVoicememoResponse,
  ChatUpdateParams,
  ChatUpdateResponse,
  ContactCardItem,
  ContactCardCreateParams,
  ContactCardRetrieveParams,
  ContactCardRetrieveResponse,
  ContactCardUpdateParams,
  ContactRequestCreateParams,
  ContactRequestCreateResponse,
  Message,
  MessageAddReactionParams,
  MessageAddReactionResponse,
  MessageCreateParams,
  MessageCreateResponse,
  MessageListParams,
  MessageSendParams,
  MessageSendResponse,
  MessageThreadParams,
  ParticipantAddParams,
  ParticipantRemoveParams,
  RequestOptions,
  UnblockHandleParams,
  WebhookEventListResponse,
  WebhookSubscription,
  WebhookSubscriptionCreateParams,
  WebhookSubscriptionCreateResponse,
  WebhookSubscriptionListResponse,
  WebhookSubscriptionUpdateParams,
} from "./types.js";
import { Webhooks } from "./webhooks.js";
import {
  runWebSocket,
  type WebSocketRunOptions,
} from "./websocket.js";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RelayOptions {
  apiKey: string;
  baseURL?: string;
  webhookSecret?: string | null;
  maxRetries?: number;
  timeout?: number;
  retryBaseDelayMs?: number;
  fetch?: FetchLike;
}

interface InternalRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: object;
  body?: unknown;
  options?: RequestOptions | undefined;
  idempotencyKey?: string;
  retryable?: boolean;
}

interface ErrorBody {
  error?: {
    status?: number;
    code?: number;
    message?: string;
    doc_url?: string;
    retry_after?: number;
  };
  trace_id?: string;
}

const delay = async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
};

const pathID = (value: string): string => encodeURIComponent(value);

class Transport {
  readonly baseURL: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #maxRetries: number;
  readonly #timeout: number;
  readonly #retryBaseDelayMs: number;

  constructor(options: RelayOptions) {
    if (!options.apiKey?.trim()) throw new Error("Relay API key is required.");
    this.baseURL = (options.baseURL ?? "https://api.relayapp.im").replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#timeout = options.timeout ?? 15_000;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
  }

  async request<T>(request: InternalRequest): Promise<T> {
    const url = new URL(`${this.baseURL}${request.path}`);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const maxRetries = request.options?.maxRetries ?? this.#maxRetries;
    const mayRetry = request.retryable === true
      || request.method === "GET"
      || request.method === "PUT"
      || request.method === "PATCH"
      || request.method === "DELETE"
      || request.idempotencyKey !== undefined;

    for (let attempt = 0; ; attempt += 1) {
      const timeout = request.options?.timeout ?? this.#timeout;
      const timeoutSignal = AbortSignal.timeout(timeout);
      const signal = request.options?.signal
        ? AbortSignal.any([request.options.signal, timeoutSignal])
        : timeoutSignal;
      const headers = new Headers(request.options?.headers);
      headers.set("authorization", `Bearer ${this.#apiKey}`);
      headers.set("accept", "application/json");
      if (request.body !== undefined) headers.set("content-type", "application/json");
      if (request.idempotencyKey) {
        headers.set("idempotency-key", request.idempotencyKey);
      }

      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: request.method,
          headers,
          ...(request.body === undefined
            ? {}
            : { body: JSON.stringify(request.body) }),
          signal,
        });
      } catch (cause) {
        if (request.options?.signal?.aborted) throw cause;
        if (isAbortError(cause) && !timeoutSignal.aborted) throw cause;
        const error = new RelayAPIError(
          timeoutSignal.aborted
            ? `Relay request timed out after ${timeout}ms.`
            : "Relay network request failed.",
          { cause },
        );
        if (!mayRetry || attempt >= maxRetries) throw error;
        await delay(this.#retryBaseDelayMs * 2 ** attempt, request.options?.signal);
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const text = await response.text();
      let body: ErrorBody | undefined;
      try {
        body = text ? JSON.parse(text) as ErrorBody : undefined;
      } catch {
        body = undefined;
      }
      const retryAfter = body?.error?.retry_after
        ?? Number(response.headers.get("retry-after") ?? NaN);
      const error = new RelayAPIError(
        body?.error?.message
          ?? `Relay request failed with HTTP ${response.status}.`,
        {
          status: response.status,
          ...(body?.error?.code === undefined ? {} : { code: body.error.code }),
          ...(body?.trace_id === undefined ? {} : { traceId: body.trace_id }),
          ...(body?.error?.doc_url === undefined
            ? {}
            : { docURL: body.error.doc_url }),
          ...(Number.isFinite(retryAfter) ? { retryAfter } : {}),
          body: body ?? text,
        },
      );
      if (!mayRetry || !error.retryable || attempt >= maxRetries) throw error;
      const wait = Number.isFinite(retryAfter)
        ? retryAfter * 1_000
        : this.#retryBaseDelayMs * 2 ** attempt;
      await delay(wait, request.options?.signal);
    }
  }

  async upload(
    allocation: AttachmentCreateResponse,
    data: BodyInit,
    options: RequestOptions = {},
  ): Promise<void> {
    const headers = new Headers(allocation.required_headers);
    for (const [name, value] of new Headers(options.headers)) {
      headers.set(name, value);
    }
    let response: Response;
    try {
      response = await this.#fetch(allocation.upload_url, {
        method: "PUT",
        headers,
        body: data,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      throw new RelayAPIError("Relay attachment upload failed.", { cause });
    }
    if (!response.ok) {
      throw new RelayAPIError(
        `Relay attachment upload failed with HTTP ${response.status}.`,
        { status: response.status },
      );
    }
  }

  runWebSocket(options: WebSocketRunOptions): Promise<void> {
    return runWebSocket(this.baseURL, this.#apiKey, options);
  }
}

class ChatMessages {
  constructor(private readonly transport: Transport) {}

  async list(
    chatID: string,
    query: MessageListParams = {},
    options?: RequestOptions,
  ): Promise<MessagesPage<Message>> {
    const body = await this.transport.request<{
      messages: Message[];
      next_cursor?: string | null;
    }>({
      method: "GET",
      path: `/v1/chats/${pathID(chatID)}/messages`,
      query,
      options,
    });
    return new MessagesPage(
      { data: body.messages, nextCursor: body.next_cursor ?? null },
      (cursor) => this.list(chatID, { ...query, cursor }, options),
    );
  }

  send(
    chatID: string,
    body: MessageSendParams,
    options?: RequestOptions,
  ): Promise<MessageSendResponse> {
    return this.transport.request({
      method: "POST",
      path: `/v1/chats/${pathID(chatID)}/messages`,
      body,
      options,
      ...(body.message.idempotency_key
        ? { idempotencyKey: body.message.idempotency_key }
        : {}),
    });
  }
}

class ChatParticipants {
  constructor(private readonly transport: Transport) {}

  add(
    chatID: string,
    body: ParticipantAddParams,
    options?: RequestOptions,
  ): Promise<AcceptedResponse> {
    return this.transport.request({
      method: "POST",
      path: `/v1/chats/${pathID(chatID)}/participants`,
      body,
      options,
    });
  }

  remove(
    chatID: string,
    body: ParticipantRemoveParams,
    options?: RequestOptions,
  ): Promise<AcceptedResponse> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/chats/${pathID(chatID)}/participants`,
      body,
      options,
    });
  }
}

export class Chats {
  readonly messages: ChatMessages;
  readonly participants: ChatParticipants;

  constructor(private readonly transport: Transport) {
    this.messages = new ChatMessages(transport);
    this.participants = new ChatParticipants(transport);
  }

  create(body: ChatCreateParams, options?: RequestOptions): Promise<ChatCreateResponse> {
    return this.transport.request({
      method: "POST",
      path: "/v1/chats",
      body,
      options,
      ...(body.message.idempotency_key
        ? { idempotencyKey: body.message.idempotency_key }
        : {}),
    });
  }

  retrieve(chatID: string, options?: RequestOptions): Promise<Chat> {
    return this.transport.request({
      method: "GET",
      path: `/v1/chats/${pathID(chatID)}`,
      options,
    });
  }

  update(
    chatID: string,
    body: ChatUpdateParams,
    options?: RequestOptions,
  ): Promise<ChatUpdateResponse> {
    return this.transport.request({
      method: "PUT",
      path: `/v1/chats/${pathID(chatID)}`,
      body,
      options,
    });
  }

  async listChats(
    query: ChatListChatsParams = {},
    options?: RequestOptions,
  ): Promise<ChatsPage<Chat>> {
    const body = await this.transport.request<{
      chats: Chat[];
      next_cursor?: string | null;
    }>({
      method: "GET",
      path: "/v1/chats",
      query,
      options,
    });
    return new ChatsPage(
      { data: body.chats, nextCursor: body.next_cursor ?? null },
      (cursor) => this.listChats({ ...query, cursor }, options),
    );
  }

  leaveChat(chatID: string, options?: RequestOptions): Promise<AcceptedResponse> {
    return this.transport.request({
      method: "POST",
      path: `/v1/chats/${pathID(chatID)}/leave`,
      options,
    });
  }

  startTyping(chatID: string, options?: RequestOptions): Promise<void> {
    return this.transport.request({
      method: "POST",
      path: `/v1/chats/${pathID(chatID)}/typing`,
      options,
      retryable: true,
    });
  }

  stopTyping(chatID: string, options?: RequestOptions): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/chats/${pathID(chatID)}/typing`,
      options,
      retryable: true,
    });
  }

  /**
   * Explicitly marks the visible Messages in this Chat as Read.
   * The SDK never calls this method automatically.
   */
  markAsRead(chatID: string, options?: RequestOptions): Promise<void> {
    return this.transport.request({
      method: "POST",
      path: `/v1/chats/${pathID(chatID)}/read`,
      options,
      retryable: true,
    });
  }

  shareContactCard(chatID: string, options?: RequestOptions): Promise<void> {
    return this.transport.request({
      method: "POST",
      path: `/v1/chats/${pathID(chatID)}/share_contact_card`,
      options,
    });
  }

  sendVoicememo(
    chatID: string,
    body: ChatSendVoicememoParams,
    options?: RequestOptions,
  ): Promise<ChatSendVoicememoResponse> {
    return this.transport.request({
      method: "POST",
      path: `/v1/chats/${pathID(chatID)}/voicememo`,
      body,
      options,
    });
  }
}

export class Messages {
  constructor(private readonly transport: Transport) {}

  create(
    params: MessageCreateParams,
    options?: RequestOptions,
  ): Promise<MessageCreateResponse> {
    const { "Idempotency-Key": headerKey, ...body } = params;
    const idempotencyKey = headerKey ?? body.message.idempotency_key;
    return this.transport.request({
      method: "POST",
      path: "/v1/messages",
      body,
      options,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  retrieve(messageID: string, options?: RequestOptions): Promise<Message> {
    return this.transport.request({
      method: "GET",
      path: `/v1/messages/${pathID(messageID)}`,
      options,
    });
  }

  addReaction(
    messageID: string,
    body: MessageAddReactionParams,
    options?: RequestOptions,
  ): Promise<MessageAddReactionResponse> {
    return this.transport.request({
      method: "POST",
      path: `/v1/messages/${pathID(messageID)}/reactions`,
      body,
      options,
    });
  }

  async listMessagesThread(
    messageID: string,
    query: MessageThreadParams = {},
    options?: RequestOptions,
  ): Promise<MessagesPage<Message>> {
    const body = await this.transport.request<{
      messages: Message[];
      next_cursor?: string | null;
    }>({
      method: "GET",
      path: `/v1/messages/${pathID(messageID)}/thread`,
      query,
      options,
    });
    return new MessagesPage(
      { data: body.messages, nextCursor: body.next_cursor ?? null },
      (cursor) => this.listMessagesThread(
        messageID,
        { ...query, cursor },
        options,
      ),
    );
  }

}

export class Attachments {
  constructor(private readonly transport: Transport) {}

  create(
    body: AttachmentCreateParams,
    options?: RequestOptions,
  ): Promise<AttachmentCreateResponse> {
    return this.transport.request({
      method: "POST",
      path: "/v1/attachments",
      body,
      options,
    });
  }

  retrieve(attachmentID: string, options?: RequestOptions): Promise<Attachment> {
    return this.transport.request({
      method: "GET",
      path: `/v1/attachments/${pathID(attachmentID)}`,
      options,
    });
  }

  delete(attachmentID: string, options?: RequestOptions): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/attachments/${pathID(attachmentID)}`,
      options,
    });
  }

  upload(
    allocation: AttachmentCreateResponse,
    data: BodyInit,
    options?: RequestOptions,
  ): Promise<void> {
    return this.transport.upload(allocation, data, options);
  }
}

export class WebhookEvents {
  constructor(private readonly transport: Transport) {}

  list(options?: RequestOptions): Promise<WebhookEventListResponse> {
    return this.transport.request({
      method: "GET",
      path: "/v1/webhook-events",
      options,
    });
  }
}

export class WebhookSubscriptions {
  constructor(private readonly transport: Transport) {}

  create(
    body: WebhookSubscriptionCreateParams,
    options?: RequestOptions,
  ): Promise<WebhookSubscriptionCreateResponse> {
    return this.transport.request({
      method: "POST",
      path: "/v1/webhook-subscriptions",
      body,
      options,
    });
  }

  retrieve(
    subscriptionID: string,
    options?: RequestOptions,
  ): Promise<WebhookSubscription> {
    return this.transport.request({
      method: "GET",
      path: `/v1/webhook-subscriptions/${pathID(subscriptionID)}`,
      options,
    });
  }

  update(
    subscriptionID: string,
    body: WebhookSubscriptionUpdateParams,
    options?: RequestOptions,
  ): Promise<WebhookSubscription> {
    return this.transport.request({
      method: "PUT",
      path: `/v1/webhook-subscriptions/${pathID(subscriptionID)}`,
      body,
      options,
    });
  }

  list(options?: RequestOptions): Promise<WebhookSubscriptionListResponse> {
    return this.transport.request({
      method: "GET",
      path: "/v1/webhook-subscriptions",
      options,
    });
  }

  delete(subscriptionID: string, options?: RequestOptions): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/webhook-subscriptions/${pathID(subscriptionID)}`,
      options,
    });
  }
}

export class ContactCard {
  constructor(private readonly transport: Transport) {}

  create(
    body: ContactCardCreateParams,
    options?: RequestOptions,
  ): Promise<ContactCardItem> {
    return this.transport.request({
      method: "POST",
      path: "/v1/contact_card",
      body,
      options,
    });
  }

  retrieve(
    query: ContactCardRetrieveParams = {},
    options?: RequestOptions,
  ): Promise<ContactCardRetrieveResponse> {
    return this.transport.request({
      method: "GET",
      path: "/v1/contact_card",
      query,
      options,
    });
  }

  update(
    params: ContactCardUpdateParams,
    options?: RequestOptions,
  ): Promise<ContactCardItem> {
    const { handle, ...body } = params;
    return this.transport.request({
      method: "PATCH",
      path: "/v1/contact_card",
      query: { handle },
      body,
      options,
    });
  }
}

export class ContactRequests {
  constructor(private readonly transport: Transport) {}

  create(
    { handle }: ContactRequestCreateParams,
    options?: RequestOptions,
  ): Promise<ContactRequestCreateResponse> {
    return this.transport.request({
      method: "POST",
      path: "/v1/contact_requests",
      body: { handle },
      options,
    });
  }
}

export class BlockedHandles {
  constructor(private readonly transport: Transport) {}

  list(options?: RequestOptions): Promise<BlockedHandleListResponse> {
    return this.transport.request({
      method: "GET",
      path: "/v1/blocked_handles",
      options,
    });
  }

  block(
    body: BlockHandleParams,
    options?: RequestOptions,
  ): Promise<BlockHandleResponse> {
    return this.transport.request({
      method: "POST",
      path: "/v1/blocked_handles",
      body,
      options,
    });
  }

  unblock(
    body: UnblockHandleParams,
    options?: RequestOptions,
  ): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: "/v1/blocked_handles",
      body,
      options,
    });
  }
}

export class WebSocket {
  constructor(private readonly transport: Transport) {}

  /**
   * Keeps one outbound WebSocket connection alive. `onEvent` must return
   * only after the event is committed to a durable inbox; the SDK sends the
   * transport-only cumulative ACK after that promise resolves. The ACK does
   * not change Delivered or Read receipts. `onFullSync` must return only after
   * a complete REST snapshot is durably applied.
   */
  run(options: WebSocketRunOptions): Promise<void> {
    return this.transport.runWebSocket(options);
  }
}

export class Relay {
  readonly baseURL: string;
  readonly chats: Chats;
  readonly messages: Messages;
  readonly attachments: Attachments;
  readonly webhookEvents: WebhookEvents;
  readonly webhookSubscriptions: WebhookSubscriptions;
  readonly contactCard: ContactCard;
  readonly contactRequests: ContactRequests;
  readonly blockedHandles: BlockedHandles;
  readonly websocket: WebSocket;
  readonly webhooks: Webhooks;

  constructor(options: RelayOptions) {
    const transport = new Transport(options);
    this.baseURL = transport.baseURL;
    this.chats = new Chats(transport);
    this.messages = new Messages(transport);
    this.attachments = new Attachments(transport);
    this.webhookEvents = new WebhookEvents(transport);
    this.webhookSubscriptions = new WebhookSubscriptions(transport);
    this.contactCard = new ContactCard(transport);
    this.contactRequests = new ContactRequests(transport);
    this.blockedHandles = new BlockedHandles(transport);
    this.websocket = new WebSocket(transport);
    this.webhooks = new Webhooks(options.webhookSecret ?? null);
  }
}

export default Relay;
