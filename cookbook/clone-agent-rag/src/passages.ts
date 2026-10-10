/** One source file and what is known about it (sources/sources.json). */
export interface Source {
  file: string;
  title: string;
  date: string;
  url: string;
  /**
   * Who is speaking in the file: `own-writing` (the person wrote it),
   * `monologue` (a talk by the person alone), `speaker-labeled` (an interview
   * where every turn names its speaker), `unlabeled-dialogue` (a conversation
   * without speaker names), or `about-them` (someone else writing about the
   * person). The model quotes exact words only from the first three.
   */
  attribution: "own-writing" | "monologue" | "speaker-labeled" | "unlabeled-dialogue" | "about-them";
}

/** One searchable passage: a chunk of a source's text and the source's fields. */
export interface Passage {
  id: string;
  text: string;
  title: string;
  date: string;
  url: string;
  attribution: Source["attribution"];
}

export const PASSAGE_WORDS = 300;
export const OVERLAP_WORDS = 40;

/**
 * Splits text into passages of about `limit` words. Each passage ends at a
 * paragraph or sentence end where one falls in its last third, and the next
 * passage repeats the last `overlap` words, so an idea cut at a boundary is
 * still whole in one of the two.
 */
export function chunkText(text: string, limit = PASSAGE_WORDS, overlap = OVERLAP_WORDS): string[] {
  const tokens = [...text.matchAll(/\S+/gu)];
  const chunks: string[] = [];
  let start = 0;
  while (start < tokens.length) {
    let end = Math.min(start + limit, tokens.length);
    if (end < tokens.length) {
      const floor = start + Math.max(1, Math.floor(limit * 0.65));
      let paragraph = -1;
      let sentence = -1;
      for (let i = floor; i <= end; i += 1) {
        const previous = tokens[i - 1]!;
        const gap = text.slice(previous.index + previous[0].length, tokens[i]!.index);
        if (gap.includes("\n\n")) paragraph = i;
        else if (/[.!?]["'”’)\]]*$/u.test(previous[0])) sentence = i;
      }
      if (paragraph > start) end = paragraph;
      else if (sentence > start) end = sentence;
    }
    chunks.push(tokens.slice(start, end).map((token) => token[0]).join(" "));
    if (end === tokens.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

/** A stable vector id from the source and the passage's place in it (Vectorize ids are at most 64 bytes). */
export async function passageId(source: Source, index: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${source.url}\n${source.file}\n${index}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Every passage of one source. */
export async function sourcePassages(source: Source, text: string): Promise<Passage[]> {
  const chunks = chunkText(text);
  return Promise.all(chunks.map(async (chunk, index) => ({
    id: await passageId(source, index),
    text: chunk,
    title: source.title,
    date: source.date,
    url: source.url,
    attribution: source.attribution,
  })));
}
