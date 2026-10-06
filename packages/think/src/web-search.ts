/**
 * Gemini's grounding citation markers, "[1.1.3]" or "[1.1.2, 1.2.6]": ids of
 * search results the person never sees. Only dotted ids match, so "[1]" or
 * "[2026]" in a Message stays as written. Copied from Relay-Agent
 * src/web-search.ts, where an agent with Google Search still wrote them under
 * its full prompt (2026-09-28).
 */
const SEARCH_MARKER = /[ \t]*\[\d+(?:\.\d+)+(?:,\s*\d+(?:\.\d+)+)*\]/gu;

export function withoutSearchMarkers(text: string): string {
  return text.replace(SEARCH_MARKER, "");
}
