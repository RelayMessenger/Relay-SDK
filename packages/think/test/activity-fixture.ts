import type { ChatActivity, ChatSetActivityParams } from "@relaymessenger/sdk";

/** In-memory final activity API, including guarded renewals and deletes. */
export class ActivityServer {
  activity: ChatActivity | null = null;
  version = 0;
  readonly calls: Array<{ method: string; id: string | null; body?: ChatSetActivityParams }> = [];

  respond(url: string, init: RequestInit = {}): Response | undefined {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("/activity")) return;
    const method = init.method ?? "GET";
    const id = parsed.searchParams.get("activity_id");
    if (method === "DELETE") {
      this.calls.push({ method, id });
      if (!id || this.activity?.id === id) {
        this.activity = null;
        this.version++;
      }
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") {
      const body = JSON.parse(String(init.body)) as ChatSetActivityParams;
      this.calls.push({ method, id: body.activity_id ?? null, body });
      if (body.activity_id && body.activity_id !== this.activity?.id) {
        return Response.json({ error: { message: "Activity task replaced" } }, { status: 409 });
      }
      this.activity = {
        id: body.activity_id ?? crypto.randomUUID(),
        text: body.text,
        emoji: body.emoji ?? null,
        updated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 90_000).toISOString(),
      };
      this.version++;
    } else {
      this.calls.push({ method, id });
    }
    return Response.json({
      chat_id: parsed.pathname.split("/")[3],
      agent_id: "01993d50-ef7b-7b37-886b-23fd80c7ec19",
      version: String(this.version),
      activity: this.activity,
    });
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
