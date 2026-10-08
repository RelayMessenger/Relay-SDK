import type { LanguageModelMiddleware } from "ai";

/**
 * One `relay_chat_timing` line per answered Message: every phase between the
 * chat object's RPC entry and the reply POST returning, so a slow answer can
 * be read as a number per phase instead of one total.
 *
 * Marks inside one isolate are `performance.now()` deltas. The alarm gap
 * (schedule → processRelayEvent) crosses a Durable Object alarm and possibly
 * an eviction, so it is a `Date.now()` delta from the wall clock stored at
 * schedule time; a record rebuilt after eviction is flagged `cold`.
 */
export type RelayChatTimingPhase =
  | "stored"
  | "scheduled"
  | "history_loaded"
  | "model_started"
  | "model_headers"
  | "first_chunk"
  | "model_done"
  | "compose_done"
  | "post_sent"
  | "post_returned";

export interface RelayChatTiming {
  readonly instance: string;
  readonly eventId: string;
  messageId?: string;
  model?: string;
  cold: boolean;
  attempts: number;
  readonly receivedAt: number;
  scheduledAt?: number;
  alarmMs?: number;
  modelCalls: number;
  toolCount: number;
  toolMs: number;
  typingStampMs?: number;
  /** Summed over every model call in the turn (AI SDK `totalUsage`). */
  tokens?: { input?: number; output?: number; reasoning?: number; cached?: number };
  /**
   * The AI Gateway's own cf-aig-* response headers for the last model call
   * (its log id and which attempt served it), so a slow first chunk can be
   * told apart: a late gateway answer, or a late first token.
   */
  gateway?: Record<string, string>;
  marks: Partial<Record<RelayChatTimingPhase, number>>;
  mark(phase: RelayChatTimingPhase): void;
}

export function newRelayInstanceId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function startRelayChatTiming(options: {
  instance: string;
  eventId: string;
  cold?: boolean;
  receivedAt?: number;
}): RelayChatTiming {
  const origin = performance.now();
  return {
    instance: options.instance,
    eventId: options.eventId,
    cold: options.cold ?? false,
    attempts: 0,
    receivedAt: options.receivedAt ?? Date.now(),
    modelCalls: 0,
    toolCount: 0,
    toolMs: 0,
    marks: {},
    mark(phase) {
      if (this.marks[phase] === undefined) {
        this.marks[phase] = performance.now() - origin;
      }
    },
  };
}

/**
 * Timestamps the alarm side: `alarmMs` is wall time between the schedule
 * returning and processRelayEvent entering. Every later mark is measured
 * from here, so a cold record (rebuilt after eviction) has the same shape.
 */
export function resumeRelayChatTiming(
  timing: RelayChatTiming,
  attempts: number,
): RelayChatTiming {
  const now = Date.now();
  const origin = performance.now();
  const base = timing.scheduledAt ?? timing.receivedAt;
  timing.alarmMs = Math.max(0, now - base);
  timing.attempts = attempts;
  timing.mark = (phase) => {
    if (timing.marks[phase] === undefined) {
      timing.marks[phase] = performance.now() - origin;
    }
  };
  return timing;
}

function addTokens(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

export function timedRelayModel(
  timing: () => RelayChatTiming | undefined,
): LanguageModelMiddleware {
  return {
    wrapStream: async ({ doStream, model }) => {
      const record = timing();
      if (record) {
        record.modelCalls += 1;
        record.model ??= model.modelId;
        record.mark("model_started");
      }
      const result = await doStream();
      if (!record) return result;
      record.mark("model_headers");
      const headers = result.response?.headers ?? {};
      const gateway = Object.fromEntries(
        Object.entries(headers).filter(([name, value]) =>
          name.toLowerCase().startsWith("cf-aig-") && typeof value === "string"
        ),
      ) as Record<string, string>;
      if (Object.keys(gateway).length) record.gateway = gateway;
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type !== "stream-start") record.mark("first_chunk");
              if (part.type === "finish") {
                record.mark("model_done");
                // One middleware call per step: add, never overwrite, so the
                // line carries the turn total like streamText's `totalUsage`.
                // A closing step after the last tool call would otherwise
                // hide every earlier step.
                const sum = record.tokens ?? {};
                record.tokens = {
                  input: addTokens(sum.input, part.usage.inputTokens.total),
                  output: addTokens(sum.output, part.usage.outputTokens.total),
                  reasoning: addTokens(sum.reasoning, part.usage.outputTokens.reasoning),
                  // Gemini's usageMetadata.cachedContentTokenCount, mapped by
                  // @ai-sdk/google to inputTokens.cacheRead (0 when absent).
                  cached: (sum.cached ?? 0) + (part.usage.inputTokens.cacheRead ?? 0),
                };
              }
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}

/**
 * One line, phases as durations (ms) in wall order, like
 * `relay_webhook_timing`. A phase that never happened is null so the shape
 * is stable for a log query.
 */
export function relayChatTimingLine(timing: RelayChatTiming): string {
  const m = timing.marks;
  const step = (
    to: RelayChatTimingPhase,
    from?: RelayChatTimingPhase,
  ): number | null => {
    const end = m[to];
    if (end === undefined) return null;
    const start = from === undefined ? 0 : m[from];
    if (start === undefined) return null;
    return Math.round(end - start);
  };
  const beforeAlarm = timing.cold
    ? 0
    : Math.round(m.scheduled ?? m.stored ?? 0);
  const afterAlarm = Math.round(m.post_returned ?? 0);
  return JSON.stringify({
    event: "relay_chat_timing",
    event_id: timing.eventId,
    message_id: timing.messageId ?? null,
    model: timing.model ?? null,
    instance: timing.instance,
    cold: timing.cold,
    attempts: timing.attempts,
    received_at: new Date(timing.receivedAt).toISOString(),
    ms: {
      stored: timing.cold ? null : step("stored"),
      scheduled: timing.cold ? null : step("scheduled", "stored"),
      alarm: timing.alarmMs === undefined
        ? null
        : Math.round(timing.alarmMs),
      typing_stamp: timing.typingStampMs === undefined ? null : Math.round(timing.typingStampMs),
      history_loaded: step("history_loaded"),
      model_started: step("model_started", "history_loaded"),
      model_headers: step("model_headers", "model_started"),
      first_chunk: step("first_chunk", "model_started"),
      model_done: step("model_done", "first_chunk"),
      compose: step("compose_done", "model_done"),
      post_sent: step("post_sent", "compose_done"),
      post: step("post_returned", "post_sent"),
      total: beforeAlarm + Math.round(timing.alarmMs ?? 0) + afterAlarm,
    },
    model_calls: timing.modelCalls,
    tools: { count: timing.toolCount, ms: Math.round(timing.toolMs) },
    gateway: timing.gateway ?? null,
    tokens: {
      input: timing.tokens?.input ?? null,
      output: timing.tokens?.output ?? null,
      reasoning: timing.tokens?.reasoning ?? null,
      cached: timing.tokens?.cached ?? 0,
    },
  });
}
