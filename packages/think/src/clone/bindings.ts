/**
 * Structural subset of Cloudflare Workers AI (`Ai`) used by speak-gate and
 * source search helpers, kept free of ambient global Workers types so
 * declarations compile under strict `moduleResolution: "nodenext"`.
 */
export interface WorkersAiBinding {
  run(
    model: never,
    inputs: never,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

/**
 * Structural subset of Cloudflare Vectorize (`VectorizeIndex`) used by source
 * archive search helpers.
 */
export interface VectorizeIndexBinding {
  query(
    vector: number[],
    options?: {
      topK?: number;
      returnMetadata?: "none" | "indexed" | "all" | boolean;
    },
  ): Promise<{
    matches: ReadonlyArray<{
      metadata?: Record<string, unknown>;
    }>;
  }>;
}
