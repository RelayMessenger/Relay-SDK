/** What a ranker reads to score each agent on the latest group Message. */
export interface SpeakRankInput {
  /** Members, earlier Messages, and the latest Message set apart. */
  state: string;
  /** The latest Message alone, as `Name: text`. */
  latest: string;
  /** The agents in the order, by display name. */
  agents: string[];
  /** Whether the latest Message mentions or replies to each agent. */
  addressed: boolean[];
  /** Whether a person, not an agent, sent the latest Message. */
  fromPerson: boolean;
}

/**
 * Scores, from 0 to 1, how much each agent should speak to the latest
 * Message, one per agent in `agents`. Every agent in the group asks with the
 * same input, so a ranker must answer the same input the same way.
 */
export type SpeakRanker = (input: SpeakRankInput) => Promise<number[]>;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The default ranker: no model call. An agent the Message mentions, replies
 * to, or names scores 1; every other agent 0.
 *
 * On a person's Message every agent still takes a turn, so this only puts
 * the named ones first. On another agent's Message only a named agent
 * answers: agents talk to each other when they ask each other something.
 */
export const namedRanker: SpeakRanker = async ({ latest, agents, addressed }) => {
  const words = latest.slice(latest.indexOf(":") + 1);
  return agents.map((name, index) => {
    if (addressed[index]) return 1;
    const first = name.split(/\s+/u)[0] ?? name;
    return new RegExp(`(^|[^\\p{L}])${escape(first)}([^\\p{L}]|$)`, "iu").test(words) ? 1 : 0;
  });
};

/** The part of the Workers AI binding the Clef ranker calls. */
export interface ClefBinding {
  run(model: "@cf/cloudflare/clef-flash", input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Past this, the agent stops waiting for Clef and takes its turn. */
export const CLEF_TIMEOUT_MS = 3_000;

/**
 * Scores with Cloudflare's Clef decision model (`@cf/cloudflare/clef-flash`,
 * a paid Workers AI model). It reads the chat and returns a probability per
 * question, one question per agent.
 *
 * A person's Message asks how much it touches each agent's own life, work or
 * expertise, which orders the agents. Another agent's Message asks whether
 * each agent has something to add that the others have not said, which
 * decides whether it answers at all.
 */
export function clefRanker(ai: ClefBinding): SpeakRanker {
  return async ({ state, agents, fromPerson }) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        ai.run("@cf/cloudflare/clef-flash", {
          model: "clef-flash",
          state,
          questions: Object.fromEntries(agents.map((name, index) => [`a${index}`, {
            type: "noul",
            instructions: fromPerson
              ? `How much does the latest message touch ${name}'s own life, work or expertise?`
              : `Would ${name} have something specific and useful to add to this group chat right now, which the others have not already said?`,
          }])),
        }, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Clef timed out"));
          }, CLEF_TIMEOUT_MS);
        }),
      ]);
      const answers = (response as { answers?: Record<string, { type?: string; noul?: unknown }> }).answers ?? {};
      return agents.map((_, index) => {
        const noul = answers[`a${index}`]?.noul;
        if (typeof noul !== "number" || noul < 0 || noul > 1) throw new Error(`Clef returned no score for a${index}`);
        return noul;
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
