export interface PageBody<T> {
  data: T[];
  nextCursor: string | null;
}

export class RelayPage<T> implements AsyncIterable<T> {
  readonly data: T[];
  readonly nextCursor: string | null;
  readonly #next: ((cursor: string) => Promise<RelayPage<T>>) | undefined;

  constructor(
    body: PageBody<T>,
    next?: (cursor: string) => Promise<RelayPage<T>>,
  ) {
    this.data = body.data;
    this.nextCursor = body.nextCursor;
    this.#next = next;
  }

  hasNextPage(): boolean {
    return this.nextCursor !== null;
  }

  async getNextPage(): Promise<RelayPage<T> | null> {
    if (!this.nextCursor) return null;
    if (!this.#next) throw new Error("Relay page has no next-page loader.");
    return this.#next(this.nextCursor);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page: RelayPage<T> | null = this;
    while (page) {
      yield* page.data;
      page = await page.getNextPage();
    }
  }
}

export class ChatsPage<T> extends RelayPage<T> {
  readonly chats: T[];

  constructor(
    body: PageBody<T>,
    next?: (cursor: string) => Promise<ChatsPage<T>>,
  ) {
    super(body, next);
    this.chats = this.data;
  }

  override async getNextPage(): Promise<ChatsPage<T> | null> {
    return await super.getNextPage() as ChatsPage<T> | null;
  }
}

export class MessagesPage<T> extends RelayPage<T> {
  readonly messages: T[];

  constructor(
    body: PageBody<T>,
    next?: (cursor: string) => Promise<MessagesPage<T>>,
  ) {
    super(body, next);
    this.messages = this.data;
  }

  override async getNextPage(): Promise<MessagesPage<T> | null> {
    return await super.getNextPage() as MessagesPage<T> | null;
  }
}
