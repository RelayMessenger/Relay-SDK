import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { chunkText, OVERLAP_WORDS, PASSAGE_WORDS } from "../src/passages";
import { EMBED_BATCH, embed, INDEX_NAME, readPassages, upsert, type CloudflareAccount } from "../scripts/ingest";

const words = (count: number, prefix = "w") => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");

describe("chunkText", () => {
  it("keeps a short text whole", () => {
    expect(chunkText("One idea. Two ideas.")).toEqual(["One idea. Two ideas."]);
  });

  it("splits long text into passages of at most 300 words that overlap by 40", () => {
    const chunks = chunkText(words(700));
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.split(" ").length).toBeLessThanOrEqual(PASSAGE_WORDS);
    const [first, second] = chunks.map((chunk) => chunk.split(" "));
    expect(second!.slice(0, OVERLAP_WORDS)).toEqual(first!.slice(-OVERLAP_WORDS));
    expect(chunks.at(-1)!.endsWith("w699")).toBe(true);
  });

  it("ends a passage at a paragraph break in its last third", () => {
    const text = `${words(250, "a")}\n\n${words(200, "b")}`;
    expect(chunkText(text)[0]!.split(" ").at(-1)).toBe("a249");
  });
});

describe("readPassages", () => {
  it("reads every sample source and carries its title, date, url and attribution", async () => {
    const passages = await readPassages(join(import.meta.dirname, "..", "sources"));
    expect(passages.length).toBeGreaterThanOrEqual(5);
    expect(new Set(passages.map((passage) => passage.id)).size).toBe(passages.length);
    for (const passage of passages) {
      expect(passage.id).toMatch(/^[0-9a-f]{32}$/u);
      expect(passage.url).toBe("https://www.gutenberg.org/ebooks/20203");
      expect(passage.attribution).toBe("own-writing");
    }
    expect(passages.some((passage) => passage.text.includes("Eat not to dullness; drink not to elevation."))).toBe(true);
  });

  it("gives the same passage the same id on every run, so a second ingest replaces it", async () => {
    const directory = join(import.meta.dirname, "..", "sources");
    expect((await readPassages(directory)).map((p) => p.id)).toEqual((await readPassages(directory)).map((p) => p.id));
  });
});

function account(responses: unknown[]) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ success: true, result: responses.shift() }));
  const value: CloudflareAccount = { accountId: "acct", apiToken: "token", indexName: INDEX_NAME, fetch: fetch as unknown as typeof globalThis.fetch };
  return { value, fetch };
}

const vector = (seed: number) => Array.from({ length: 1_024 }, () => seed);

describe("embed and upsert", () => {
  it("embeds passages with bge-m3 through the Workers AI REST API, in batches", async () => {
    const texts = Array.from({ length: EMBED_BATCH + 1 }, (_, i) => `passage ${i}`);
    const { value, fetch } = account([{ data: texts.slice(0, EMBED_BATCH).map((_, i) => vector(i)) }, { data: [vector(9)] }]);
    expect(await embed(value, texts)).toHaveLength(texts.length);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/baai/bge-m3");
    expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer token");
    expect(JSON.parse(init!.body as string)).toEqual({ text: texts.slice(0, EMBED_BATCH) });
  });

  it("refuses vectors of the wrong dimensions", async () => {
    const { value } = account([{ data: [[0.1, 0.2]] }]);
    await expect(embed(value, ["one"])).rejects.toThrow("wrong dimensions");
  });

  it("refuses a failed Cloudflare response", async () => {
    const fetch = vi.fn(async () => Response.json({ success: false, errors: [{ message: "no" }], result: null }, { status: 403 }));
    await expect(embed({ ...account([]).value, fetch: fetch as unknown as typeof globalThis.fetch }, ["one"]))
      .rejects.toThrow("failed with 403");
  });

  it("upserts each passage with its vector and source fields as NDJSON into clone-sources", async () => {
    const passages = await readPassages(join(import.meta.dirname, "..", "sources"));
    const { value, fetch } = account([{ mutationId: "m1" }]);
    await upsert(value, passages, passages.map((_, i) => vector(i)));
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/vectorize/v2/indexes/clone-sources/upsert");
    expect(new Headers(init!.headers).get("Content-Type")).toBe("application/x-ndjson");
    const lines = (init!.body as string).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(passages.length);
    expect(lines[0]).toEqual({
      id: passages[0]!.id,
      values: vector(0),
      metadata: {
        text: passages[0]!.text,
        title: passages[0]!.title,
        date: passages[0]!.date,
        url: passages[0]!.url,
        attribution: "own-writing",
      },
    });
  });
});
