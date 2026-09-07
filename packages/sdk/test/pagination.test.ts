import { expect, it } from "vitest";
import Relay from "../src/index.js";

it("iterates cursor pages without polling", async () => {
  const cursors: Array<string | null> = [];
  const client = new Relay({
    apiKey: "token",
    fetch: async (input) => {
      const cursor = new URL(input instanceof Request ? input.url : input)
        .searchParams.get("cursor");
      cursors.push(cursor);
      return cursor === null
        ? Response.json({
            chats: [{ id: "one" }, { id: "two" }],
            next_cursor: "next",
          })
        : Response.json({
            chats: [{ id: "three" }],
            next_cursor: null,
          });
    },
  });
  const ids: string[] = [];
  const first = await client.chats.listChats({ limit: 2 });
  expect(first.chats.map((chat) => chat.id)).toEqual(["one", "two"]);
  expect(first.data).toBe(first.chats);
  expect(first.hasNextPage()).toBe(true);
  const second = await first.getNextPage();
  expect(second?.chats.map((chat) => chat.id)).toEqual(["three"]);
  expect(second?.hasNextPage()).toBe(false);

  for await (const chat of first) {
    ids.push(chat.id);
  }
  expect(ids).toEqual(["one", "two", "three"]);
  expect(cursors).toEqual([null, "next", "next"]);
});
