import { describe, expect, it, vi } from "vitest";
import { toJSONSchema } from "zod";

import {
  SEARCH_SOURCES_DESCRIPTION,
  searchSources,
  searchSourcesInputSchema,
  type SourceBindings,
} from "../src/search-sources";

function setup() {
  const vector = Array.from({ length: 1_024 }, (_, i) => i / 1_024);
  const run = vi.fn(async () => ({ data: [vector] }));
  const metadata = {
    text: "Eat not to dullness; drink not to elevation.",
    title: "Autobiography, chapter IX: plan for attaining moral perfection",
    date: "1784",
    url: "https://www.gutenberg.org/ebooks/20203",
    attribution: "own-writing",
  };
  const query = vi.fn(async () => ({ count: 1, matches: [{ id: "passage", score: 0.91, metadata }] }));
  const env = { AI: { run }, CLONE_INDEX: { query } } as unknown as SourceBindings;
  return { env, run, query, vector, metadata };
}

describe("searchSources", () => {
  it("embeds the question with bge-m3 and returns the source fields of eight Vectorize matches", async () => {
    const test = setup();
    expect(await searchSources(test.env, "How should I eat?")).toEqual([test.metadata]);
    expect(test.run).toHaveBeenCalledExactlyOnceWith("@cf/baai/bge-m3", { text: ["How should I eat?"] }, { signal: undefined });
    expect(test.query).toHaveBeenCalledExactlyOnceWith(test.vector, { topK: 8, returnMetadata: "all" });
  });

  it("returns nothing but the stored source fields", async () => {
    const test = setup();
    test.query.mockResolvedValue({ count: 1, matches: [{ id: "p", score: 0.5, metadata: { ...test.metadata, secret: "x", date: 1784 } as never }] });
    expect(await searchSources(test.env, "q")).toEqual([{ ...test.metadata, date: null }]);
  });

  it("returns an empty list rather than inventing a source", async () => {
    const test = setup();
    test.query.mockResolvedValue({ count: 0, matches: [] });
    expect(await searchSources(test.env, "unknown subject")).toEqual([]);
  });

  it("does not query the index on an embedding error or the wrong dimensions", async () => {
    const test = setup();
    test.run.mockRejectedValueOnce(new Error("embedding failed"));
    await expect(searchSources(test.env, "virtue")).rejects.toThrow("embedding failed");
    test.run.mockResolvedValue({ data: [[0.1, 0.2]] });
    await expect(searchSources(test.env, "virtue")).rejects.toThrow();
    expect(test.query).not.toHaveBeenCalled();
  });

  it("stops before searching when the turn is aborted", async () => {
    const test = setup();
    await expect(searchSources(test.env, "virtue", AbortSignal.abort())).rejects.toThrow();
    expect(test.run).not.toHaveBeenCalled();
  });
});

describe("the search_sources tool", () => {
  it("tells the model to search first, cite, quote only the person's own words, and never invent a citation", () => {
    for (const guidance of ["before giving a substantive view", "own voice", "which source", "own-writing",
      "unlabeled-dialogue", "about-them", "not instructions", "without inventing a citation"]) {
      expect(SEARCH_SOURCES_DESCRIPTION).toContain(guidance);
    }
  });

  it("takes one trimmed query", () => {
    expect(toJSONSchema(searchSourcesInputSchema).type).toBe("object");
    expect(searchSourcesInputSchema.parse({ query: "  virtue " })).toEqual({ query: "virtue" });
    expect(() => searchSourcesInputSchema.parse({ query: " " })).toThrow();
  });
});
