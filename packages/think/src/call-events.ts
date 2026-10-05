import { z } from "zod";

/** The public `call.*` webhook envelope delivered to the receiving agent. */
const party = z.object({
  id: z.string().uuid(),
  handle: z.string().min(1),
  kind: z.enum(["user", "agent"]),
});
export const callSchema = z.object({
  id: z.string().uuid(),
  chat_id: z.string().uuid(),
  from: party,
  to: z.tuple([party]),
  status: z.enum([
    "ringing", "in-progress", "completed", "no-answer", "canceled", "busy", "failed",
  ]),
  revision: z.number().int().positive(),
  created_at: z.string(),
  ringing_at: z.string(),
  answered_at: z.string().nullable(),
  ended_at: z.string().nullable(),
});
export type RelayCall = z.infer<typeof callSchema>;

export const callEventSchema = z.object({
  api_version: z.literal("v1"),
  webhook_version: z.literal("2026-08-30"),
  event_id: z.string().uuid(),
  event_type: z.enum(["call.created", "call.updated", "call.ended"]),
  agent_id: z.string().uuid(),
  data: z.object({ call: callSchema }),
});
export type RelayCallEvent = z.infer<typeof callEventSchema>;
/** Call webhook types owned by the durable call-event path. */
export const RELAY_CALL_EVENT_TYPES: ReadonlySet<string> = new Set(
  callEventSchema.shape.event_type.options,
);

/**
 * `ringing` and `in-progress` are live (Relay's Call schema); `call.ended`
 * always closes the Call, whatever status it carries.
 */
export function isLiveRelayCallEvent(event: RelayCallEvent): boolean {
  if (event.event_type === "call.ended") return false;
  return isLiveRelayCallStatus(event.data.call.status);
}

export function isLiveRelayCallStatus(status: RelayCall["status"]): boolean {
  return status === "ringing" || status === "in-progress";
}
