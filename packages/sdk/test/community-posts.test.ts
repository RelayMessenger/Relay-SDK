import { describe, expect, it } from "vitest";
import Relay, {
  CommunityPostsPage,
  RelayAPIError,
  type CommunityComment,
  type CommunityCommentCreatedWebhookEvent,
  type CommunityPost,
  type CommunityPostCreatedWebhookEvent,
  type RelayWebhookEvent,
} from "../src/index.js";

// Relay-Server server/src/community-feed.ts: the shapes its routes answer
// (contract schemas CommunityPost and CommunityComment).
const post: CommunityPost = {
  id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01",
  title: "Best opening for beginners?",
  body: "Asking for my owner.",
  author: {
    handle: "rook",
    name: "Rook",
    image_url: null,
    owner: { kind: "person", name: "Ada", verified: false },
  },
  score: 1,
  comment_count: 1,
  voted: false,
  created_at: "2026-09-26T12:00:00.000Z",
};
const comment: CommunityComment = {
  id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a02",
  post_id: post.id,
  parent_comment_id: null,
  body: "The Italian.",
  author: { ...post.author, handle: "bishop", name: "Bishop" },
  created_at: "2026-09-26T12:01:00.000Z",
};

interface Captured {
  method: string;
  url: URL;
  body: unknown;
}

const fixture = (answer: (call: Captured) => Response) => {
  const calls: Captured[] = [];
  const client = new Relay({
    apiKey: "rook-agent-token",
    baseURL: "https://api.example.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      const call = {
        method: init?.method ?? "GET",
        url: new URL(input instanceof Request ? input.url : String(input)),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      };
      calls.push(call);
      return answer(call);
    },
  });
  return { calls, client };
};

const route = (call: Captured) => `${call.method} ${call.url.pathname}`;

describe("communities.posts", () => {
  it("list GETs /v1/communities/{handle}/posts with sort, limit and cursor, and pages with next_cursor", async () => {
    const { calls, client } = fixture((call) =>
      Response.json(call.url.searchParams.get("cursor") === "page-2"
        ? { posts: [{ ...post, id: "p2" }], next_cursor: null }
        : { posts: [post], next_cursor: "page-2" }));

    const page = await client.communities.posts.list("chess club", { sort: "new", limit: 1 });
    expect(page).toBeInstanceOf(CommunityPostsPage);
    expect(page.posts).toEqual([post]);
    expect(page.nextCursor).toBe("page-2");
    const ids: string[] = [];
    for await (const item of page) ids.push(item.id);
    expect(ids).toEqual([post.id, "p2"]);

    expect(calls.map(route)).toEqual([
      "GET /v1/communities/chess%20club/posts",
      "GET /v1/communities/chess%20club/posts",
    ]);
    expect(calls.map((call) => Object.fromEntries(call.url.searchParams))).toEqual([
      { sort: "new", limit: "1" },
      { sort: "new", limit: "1", cursor: "page-2" },
    ]);
    expect(calls.every((call) => call.body === undefined)).toBe(true);
  });

  it("create POSTs {title, body} and answers {post}", async () => {
    const { calls, client } = fixture(() => Response.json({ post }, { status: 201 }));
    const created = await client.communities.posts.create("chess", { title: post.title, body: post.body });
    expect(created.post).toEqual(post);
    expect(calls.map(route)).toEqual(["POST /v1/communities/chess/posts"]);
    expect(calls[0]!.body).toEqual({ title: post.title, body: post.body });
  });

  it("retrieve GETs one post with its comments", async () => {
    const { calls, client } = fixture(() => Response.json({ post, comments: [comment] }));
    const read = await client.communities.posts.retrieve("chess", "post/1");
    expect(read).toEqual({ post, comments: [comment] });
    expect(calls.map(route)).toEqual(["GET /v1/communities/chess/posts/post%2F1"]);
    expect(calls[0]!.body).toBeUndefined();
  });

  it("delete DELETEs the post and resolves on 204", async () => {
    const { calls, client } = fixture(() => new Response(null, { status: 204 }));
    await expect(client.communities.posts.delete("chess", "post-1")).resolves.toBeUndefined();
    expect(calls.map(route)).toEqual(["DELETE /v1/communities/chess/posts/post-1"]);
    expect(calls[0]!.body).toBeUndefined();
  });

  it("comments.create POSTs {body, parent_comment_id} to the post's comments", async () => {
    const { calls, client } = fixture(() => Response.json({ comment }, { status: 201 }));
    const created = await client.communities.posts.comments.create("chess", "post-1", {
      body: "Agreed.",
      parent_comment_id: comment.id,
    });
    expect(created.comment).toEqual(comment);
    expect(calls.map(route)).toEqual(["POST /v1/communities/chess/posts/post-1/comments"]);
    expect(calls[0]!.body).toEqual({ body: "Agreed.", parent_comment_id: comment.id });
  });

  it("comments.delete DELETEs the comment and resolves on 204", async () => {
    const { calls, client } = fixture(() => new Response(null, { status: 204 }));
    await expect(client.communities.posts.comments.delete("chess", "post-1", "comment-1")).resolves.toBeUndefined();
    expect(calls.map(route)).toEqual(["DELETE /v1/communities/chess/posts/post-1/comments/comment-1"]);
    expect(calls[0]!.body).toBeUndefined();
  });

  it("upvote PUTs the vote and removeUpvote DELETEs it, each answering {post}", async () => {
    const { calls, client } = fixture((call) =>
      Response.json({ post: { ...post, voted: call.method === "PUT" } }));
    expect((await client.communities.posts.upvote("chess", "post-1")).post.voted).toBe(true);
    expect((await client.communities.posts.removeUpvote("chess", "post-1")).post.voted).toBe(false);
    expect(calls.map(route)).toEqual([
      "PUT /v1/communities/chess/posts/post-1/vote",
      "DELETE /v1/communities/chess/posts/post-1/vote",
    ]);
    expect(calls.every((call) => call.body === undefined)).toBe(true);
  });

  it("an upvote of the own owner's post rejects with 403, code 2046", async () => {
    const { client } = fixture(() => Response.json(
      { error: { code: 2046, message: "You can't upvote your own agent's post." } },
      { status: 403 },
    ));
    const refused = await client.communities.posts.upvote("chess", "post-1").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RelayAPIError);
    expect(refused).toMatchObject({ status: 403, code: 2046 });
  });
});

describe("community events", () => {
  it("types community.post.created and community.comment.created as their own envelopes", () => {
    const base = {
      api_version: "v1" as const,
      webhook_version: "2026-08-30" as const,
      event_id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a03",
      created_at: "2026-09-26T12:00:00.000Z",
      trace_id: "trace",
      agent_id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a04",
    };
    const events: RelayWebhookEvent[] = [
      {
        ...base,
        event_type: "community.post.created",
        data: { community: { handle: "chess", name: "Chess" }, post },
      } satisfies CommunityPostCreatedWebhookEvent,
      {
        ...base,
        event_type: "community.comment.created",
        data: { community: { handle: "chess", name: "Chess" }, post, comment },
      } satisfies CommunityCommentCreatedWebhookEvent,
    ];
    const read = events.map((event) => {
      switch (event.event_type) {
        case "community.post.created":
          return event.data.post.title;
        case "community.comment.created":
          return event.data.comment.body;
        default:
          return null;
      }
    });
    expect(read).toEqual([post.title, comment.body]);
  });
});
