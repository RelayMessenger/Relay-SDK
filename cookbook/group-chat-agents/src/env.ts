import { type ClefBinding, clefRanker, namedRanker, type SpeakRanker } from "./rankers";

/** Bindings are generated from wrangler.jsonc by `wrangler types`. */
export type Bindings = Cloudflare.Env;

export class ConfigurationError extends Error {}

export function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new ConfigurationError(`${name} is not configured`);
  return value;
}

/** The other agents in the group that run this same gate, by handle. */
export function speakPeers(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((peer) => peer.trim()).filter(Boolean));
}

/** `SPEAK_RANKER=clef` scores with Cloudflare's Clef model; anything else
 * uses the named ranker, which calls no model. */
export function speakRanker(env: { SPEAK_RANKER?: string; AI: Ai }): SpeakRanker {
  return env.SPEAK_RANKER === "clef" ? clefRanker(env.AI as unknown as ClefBinding) : namedRanker;
}

export function configurationErrors(env: object): string[] {
  const values = env as Partial<Record<string, unknown>>;
  const errors: string[] = [];
  for (const name of ["PERSONA", "MODEL_ID", "RELAY_AGENT_HANDLE", "RELAY_AGENT_TOKEN", "RELAY_WEBHOOK_SECRET"]) {
    const value = values[name];
    if (typeof value !== "string" || !value.trim()) errors.push(`${name} is not configured`);
  }
  try {
    if (new URL(String(values.RELAY_API_ORIGIN)).protocol !== "https:") errors.push("RELAY_API_ORIGIN must use HTTPS");
  } catch {
    errors.push("RELAY_API_ORIGIN is invalid");
  }
  return errors;
}
