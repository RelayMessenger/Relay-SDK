import { generateText, type LanguageModel, type Tool } from "ai";

import { withoutSearchMarkers } from "../web-search.js";

export { withoutSearchMarkers };

/** A Worker without the flag offers no search. */
export function webSearchEnabled(env: { RELAY_WEB_SEARCH?: string }): boolean {
  return env.RELAY_WEB_SEARCH === "true";
}

/** The tool's name in the turn's tool set. */
export const WEB_SEARCH_TOOL = "google_search";

/** Gemini's URL context tool, offered beside Google Search under the same flag. */
export const URL_CONTEXT_TOOL = "url_context";

export const WEB_SEARCH_GUIDANCE = "You can look things up on Google Search. Search before you state a fact that "
  + "changes or that you are not sure of: a price, a fare, a law, a rule, a schedule, today's news, whether "
  + "something is a scam. Never invent a number or a source. Your words are what the person reads: never write "
  + "search citation markers such as [1.2]; say where the fact comes from in plain words (the site, the "
  + "company or the law), and never make up a web address. You can also open and read a web page someone sends you.";

interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
}

/**
 * What one model step searched, read from the Vertex provider's metadata
 * (`googleVertex.groundingMetadata`): the queries and any web sources.
 * Undefined when the step did not search.
 */
export function webSearchUse(
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): { queries: string[]; sources: Array<{ title?: string; uri?: string }> } | undefined {
  const grounding = (providerMetadata?.googleVertex ?? providerMetadata?.vertex)
    ?.groundingMetadata as GroundingMetadata | undefined;
  const queries = grounding?.webSearchQueries ?? [];
  if (queries.length === 0) return undefined;
  return {
    queries,
    sources: (grounding?.groundingChunks ?? [])
      .flatMap(({ web }) => web ? [{ title: web.title, uri: web.uri }] : []),
  };
}

interface UrlContextMetadata {
  urlMetadata?: Array<{ retrievedUrl?: string; urlRetrievalStatus?: string }> | null;
}

/**
 * The pages one model step opened with URL context, read from the Vertex
 * provider's metadata (`urlContextMetadata`): each URL and its retrieval
 * status. Undefined when the step opened no page.
 */
export function urlContextUse(
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): { urls: Array<{ url?: string; status?: string }> } | undefined {
  const metadata = (providerMetadata?.googleVertex ?? providerMetadata?.vertex)
    ?.urlContextMetadata as UrlContextMetadata | undefined;
  const urls = (metadata?.urlMetadata ?? [])
    .map(({ retrievedUrl, urlRetrievalStatus }) => ({ url: retrievedUrl, status: urlRetrievalStatus }));
  return urls.length === 0 ? undefined : { urls };
}

/** The answer a follow-up's fresh lookup gives when its text needs no current fact. */
export const NOTHING_TO_LOOK_UP = "nothing to look up";

/** Result of a grounded fresh-fact lookup for a scheduled follow-up. */
export interface FreshCheckResult {
  checked_at: string;
  answer: string;
  searched: boolean;
  sources: Array<{ title?: string; uri?: string }>;
}

/**
 * Run a single grounded lookup with Google Search as its only tool so a
 * scheduled follow-up verifies fresh facts before texting the user.
 */
export async function freshCheck(
  model: LanguageModel,
  searchTool: Tool,
  question: string,
  now: Date,
  options: { mayNeedNothing?: boolean; signal?: AbortSignal } = {},
): Promise<FreshCheckResult | undefined> {
  const result = await generateText({
    model,
    tools: { [WEB_SEARCH_TOOL]: searchTool },
    prompt: options.mayNeedNothing
      ? `A text is about to go out for this purpose. If it will state any fact that changes (a price, a fare, `
        + `a rule, a date, news), look those facts up on Google Search now and answer with the current facts, `
        + `numbers and where they come from, in at most six short lines. If it needs no such fact, answer `
        + `exactly: ${NOTHING_TO_LOOK_UP}. Today is ${now.toISOString().slice(0, 10)}.\n\nPurpose: ${question}`
      : `Look this up on Google Search now and answer with the current facts, numbers and where they `
        + `come from, in at most six short lines. Today is ${now.toISOString().slice(0, 10)}.\n\n${question}`,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  });
  if (options.mayNeedNothing && result.text.trim().toLowerCase().startsWith(NOTHING_TO_LOOK_UP)) return undefined;
  const use = webSearchUse(result.providerMetadata as Record<string, Record<string, unknown>> | undefined);
  const sources = result.sources
    .flatMap((source) => source.sourceType === "url" ? [{ title: source.title, uri: source.url }] : [])
    .slice(0, 5);
  return {
    checked_at: now.toISOString(),
    answer: withoutSearchMarkers(result.text).trim().slice(0, 4_000),
    searched: use !== undefined,
    sources: sources.length > 0 ? sources : (use?.sources ?? []).slice(0, 5),
  };
}
