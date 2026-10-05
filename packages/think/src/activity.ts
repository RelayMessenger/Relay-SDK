import type Relay from "@relaymessenger/sdk";
import type { ChatSetActivityParams } from "@relaymessenger/sdk";

import { abortableDelay } from "./typing";

export const ACTIVITY_REFRESH_MS = 60_000;

/** The model's own status words: Relay-Agent writes none of its own. */
export type RelayActivityBody = Pick<ChatSetActivityParams, "text" | "emoji">;

type ActivityClient = Pick<Relay["chats"], "setActivity" | "clearActivity">;

export interface RelayGenerationActivity {
  stop(): Promise<void>;
}

function logActivityFailure(
  operation: "start" | "renew" | "clear" | "track",
  chatId: string,
  error: unknown,
): void {
  console.warn(JSON.stringify({
    event: "relay_agent_activity_failed",
    operation,
    chat_id: chatId,
    // Do not log provider messages, request bodies, or credentials.
    ...(error instanceof Error ? { error_type: error.name } : {}),
    ...(typeof error === "object" && error !== null && "status" in error
      && typeof error.status === "number" ? { http_status: error.status } : {}),
  }));
}

/**
 * Owned by one chat/call runtime, never by the Worker module. Only initial
 * writes are serialized: an older, slow PUT must not replace a newer task.
 * Generation itself does not wait for the activity request.
 */
export class RelayGenerationActivities {
  private starting?: Promise<void>;

  start(
    chats: ActivityClient,
    chatId: string,
    body: RelayActivityBody,
    assertCurrent: () => void,
    waitUntil?: (task: Promise<void>) => void,
  ): RelayGenerationActivity {
    const refreshController = new AbortController();
    let stopped = false;
    let activityId: string | undefined;
    let stopTask: Promise<void> | undefined;
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });

    const begin = async () => {
      if (stopped) return;
      try {
        assertCurrent();
        // An unguarded PUT creates a new task. Never retry it or abort its
        // response on turn cancellation: we need its ID for guarded cleanup.
        const state = await chats.setActivity(chatId, body, { maxRetries: 0 });
        activityId = state.activity?.id;
      } catch (error) {
        logActivityFailure("start", chatId, error);
      }
    };
    const started = this.starting ? this.starting.then(begin) : begin();
    this.starting = started;
    const refreshTask = (async () => {
      await started;
      if (this.starting === started) this.starting = undefined;
      if (!activityId) return;
      while (!stopped) {
        try {
          await abortableDelay(ACTIVITY_REFRESH_MS, refreshController.signal);
        } catch {
          return;
        }
        if (stopped) return;
        try {
          await chats.setActivity(chatId, {
            ...body,
            activity_id: activityId,
          }, { maxRetries: 0 });
        } catch (error) {
          logActivityFailure("renew", chatId, error);
          // 409 means replaced/cleared, not expired. An expired current ID
          // can still renew; never recreate a task whose ID no longer matches.
          if (typeof error === "object" && error !== null
            && "status" in error && error.status === 409) return;
        }
      }
    })();

    try {
      // Think may race the Action against cancellation and return before its
      // finally finishes. Keep the operation's guarded cleanup alive too.
      waitUntil?.(completed);
    } catch (error) {
      logActivityFailure("track", chatId, error);
    }

    return {
      stop: () => {
        stopTask ??= (async () => {
          stopped = true;
          refreshController.abort();
          // Includes an in-flight start/renewal. Clear only our returned ID,
          // even if another task has started while this one was finishing.
          await refreshTask;
          if (!activityId) return;
          try {
            await chats.clearActivity(chatId, {
              activity_id: activityId,
            }, { maxRetries: 0 });
          } catch (error) {
            logActivityFailure("clear", chatId, error);
          }
        })().finally(complete);
        return stopTask;
      },
    };
  }
}
