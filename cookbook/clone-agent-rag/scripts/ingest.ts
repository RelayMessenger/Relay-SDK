// Turns the person's public words into a searchable Vectorize index.
//
//   npm run ingest -- --dry-run   read sources/, print the passages, call nothing
//   npm run ingest                embed every passage with bge-m3 and upsert it
//
// sources/sources.json lists each text file with its title, date, url and
// attribution. Each file is split into passages of about 300 words
// (src/passages.ts), embedded with Workers AI @cf/baai/bge-m3 (1,024
// dimensions) and upserted into the Vectorize index that wrangler.jsonc binds
// as CLONE_INDEX. Upserting the same sources again replaces their vectors.
//
// Needs CLOUDFLARE_ACCOUNT_ID and a CLOUDFLARE_API_TOKEN with Workers AI and
// Vectorize edit permissions. Create the index once first:
//   npx wrangler vectorize create clone-sources --dimensions=1024 --metric=cosine
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { type Passage, type Source, sourcePassages } from "../src/passages";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../src/search-sources";

const API = "https://api.cloudflare.com/client/v4/accounts";
/** The index_name wrangler.jsonc binds as CLONE_INDEX. */
export const INDEX_NAME = "clone-sources";
/** Passages per embedding request: well under bge-m3's context in one batch. */
export const EMBED_BATCH = 20;
/** Vectors per upsert request: the Vectorize HTTP limit is 5,000 and 100 MB. */
export const UPSERT_BATCH = 1_000;
/** Vectorize metadata is at most 10 KiB per vector. */
const METADATA_BYTES = 10 * 1_024;

export interface CloudflareAccount {
  accountId: string;
  apiToken: string;
  indexName: string;
  fetch?: typeof fetch;
}

/** Reads sources/sources.json and every file it lists, and returns their passages. */
export async function readPassages(directory: string): Promise<Passage[]> {
  const sources = JSON.parse(await readFile(join(directory, "sources.json"), "utf8")) as Source[];
  const passages: Passage[] = [];
  for (const source of sources) {
    passages.push(...await sourcePassages(source, await readFile(join(directory, source.file), "utf8")));
  }
  return passages;
}

async function cloudflare<T>(account: CloudflareAccount, path: string, init: RequestInit): Promise<T> {
  const response = await (account.fetch ?? fetch)(`${API}/${account.accountId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${account.apiToken}`, ...init.headers },
  });
  const body = await response.json() as { result?: T; errors?: unknown };
  if (!response.ok || body.result === undefined) {
    throw new Error(`Cloudflare ${path} failed with ${response.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.result;
}

/** Embeds texts with bge-m3 through the Workers AI REST API, in batches. */
export async function embed(account: CloudflareAccount, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const result = await cloudflare<{ data: number[][] }>(account, `/ai/run/${EMBEDDING_MODEL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: batch }),
    });
    if (result.data.length !== batch.length || result.data.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(`bge-m3 returned ${result.data.length} vectors for ${batch.length} passages, or the wrong dimensions`);
    }
    vectors.push(...result.data);
  }
  return vectors;
}

/** Upserts passages and their vectors into the Vectorize index as NDJSON. */
export async function upsert(account: CloudflareAccount, passages: Passage[], vectors: number[][]): Promise<void> {
  for (let i = 0; i < passages.length; i += UPSERT_BATCH) {
    const lines = passages.slice(i, i + UPSERT_BATCH).map((passage, offset) => {
      const metadata = {
        text: passage.text,
        title: passage.title,
        date: passage.date,
        url: passage.url,
        attribution: passage.attribution,
      };
      if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > METADATA_BYTES) {
        throw new Error(`Passage ${passage.id} has more than 10 KiB of metadata; shorten PASSAGE_WORDS`);
      }
      return JSON.stringify({ id: passage.id, values: vectors[i + offset], metadata });
    });
    await cloudflare(account, `/vectorize/v2/indexes/${encodeURIComponent(account.indexName)}/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: `${lines.join("\n")}\n`,
    });
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(argv: string[]) {
  const root = resolve(import.meta.dirname, "..");
  const passages = await readPassages(join(root, "sources"));
  console.log(`${passages.length} passages from sources/sources.json`);
  if (argv.includes("--dry-run")) {
    for (const passage of passages) {
      console.log(`\n[${passage.id}] ${passage.title} (${passage.attribution})\n${passage.text}`);
    }
    return;
  }
  const account: CloudflareAccount = {
    accountId: required("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: required("CLOUDFLARE_API_TOKEN"),
    indexName: INDEX_NAME,
  };
  const vectors = await embed(account, passages.map((passage) => passage.text));
  await upsert(account, passages, vectors);
  console.log(`upserted ${passages.length} passages into ${account.indexName}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2));
}
