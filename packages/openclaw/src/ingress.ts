import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { createStandardRawEventIngressMonitor } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createChannelIngressError,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { RelayIngressPayload } from "./types.js";

export type RelayIngressLifecycle = Omit<
  ChannelIngressMonitorLifecycle,
  "admission"
>;

const RelayIngressPermanentError = createChannelIngressError<"invalid-event">(
  "RelayIngressPermanentError",
  { withReason: true },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspectRelayEvent(event: RelayWebhookEvent): {
  eventId: string;
  laneKey: string;
} {
  if (!isRecord(event)) {
    throw new RelayIngressPermanentError(
      "invalid-event",
      "Relay WebSocket event must be an object.",
    );
  }
  const eventId =
    typeof event.event_id === "string" ? event.event_id.trim() : "";
  const eventType =
    typeof event.event_type === "string" ? event.event_type.trim() : "";
  if (!eventId || !eventType) {
    throw new RelayIngressPermanentError(
      "invalid-event",
      "Relay WebSocket event is missing event_id or event_type.",
    );
  }
  const data = isRecord(event.data) ? event.data : undefined;
  const chat = data && isRecord(data.chat) ? data.chat : undefined;
  const chatId =
    typeof chat?.id === "string"
      ? chat.id.trim()
      : typeof data?.chat_id === "string"
        ? data.chat_id.trim()
        : "";
  return {
    eventId,
    laneKey: chatId ? `chat:${chatId}` : `event:${eventType}`,
  };
}

function decodeRelayEvent(
  rawEvent: string,
  claimedId: string,
): RelayWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new RelayIngressPermanentError(
      "invalid-event",
      `Relay ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  inspectRelayEvent(parsed as RelayWebhookEvent);
  return parsed as RelayWebhookEvent;
}

export function createRelayIngressMonitor(options: {
  queue: ChannelIngressQueue<RelayIngressPayload>;
  dispatch: (
    event: RelayWebhookEvent,
    lifecycle: RelayIngressLifecycle,
  ) => Promise<void>;
  abortSignal?: AbortSignal;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  return createStandardRawEventIngressMonitor<
    RelayWebhookEvent,
    unknown,
    { eventId: string; laneKey: string }
  >({
    queue: options.queue,
    inspect: inspectRelayEvent,
    payload: {
      serialize: (event) => JSON.stringify(event),
      deserialize: (rawEvent, { claim }) =>
        decodeRelayEvent(rawEvent, claim.id),
      createClaimError: (kind, claim) =>
        new RelayIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Relay ingress row ${claim.id} has an invalid payload version.`
            : `Relay ingress row ${claim.id} changed identity after admission.`,
        ),
    },
    deliver: async (event, lifecycle) => {
      await options.dispatch(event, lifecycle);
    },
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    createStoppedError: () => new Error("Relay ingress monitor is stopped."),
    onError: (error) => options.onError?.(error),
    classifyAdmissionError: (error) =>
      error instanceof RelayIngressPermanentError
        ? error.message
        : undefined,
  });
}

export type RelayIngressMonitor = ReturnType<
  typeof createRelayIngressMonitor
>;
