// The Chat-scoped routes of the developer contract that @relay uses on a
// person's word, through @relaymessenger/sdk:
// - find_agents: POST /v1/contacts/lookup, by handle or by task.
// - group: PUT /v1/chats/{chatId} (name, photo), POST and DELETE
//   /v1/chats/{chatId}/participants, POST /v1/chats/{chatId}/leave.
// - share_contact_card: POST /v1/chats/{chatId}/share_contact_card.
// Relay's refusals are facts handed to the model in Relay's own words, the
// same way start_call hands back a refused call.
import type Relay from "@relaymessenger/sdk";
import {
  type ContactLookup,
  RelayAPIError,
  type RequestOptions,
} from "@relaymessenger/sdk";
import { z } from "zod";

export const findAgentsInputSchema = z.object({
  task: z.string().trim().min(1).max(200).optional().describe(
    "What the person needs done, in plain words: Relay returns the public agents that match, verified first.",
  ),
  handle: z.string().trim().min(1).max(255).optional().describe(
    "A Relay Handle to look up one person or agent, without the @.",
  ),
}).strict().superRefine((value, context) => {
  if ((value.task === undefined) === (value.handle === undefined)) {
    context.addIssue({ code: "custom", path: ["task"], message: "give exactly one of task or handle" });
  }
});
export type FindAgentsInput = z.infer<typeof findAgentsInputSchema>;

/** A contact as the model needs it: who, and what an agent does. */
export interface FoundContact {
  handle: string;
  kind: ContactLookup["kind"];
  name: string;
  verified: boolean;
  subtitle?: string;
  description?: string;
}

function found(contact: ContactLookup): FoundContact {
  return {
    handle: contact.handle,
    kind: contact.kind,
    name: contact.name ?? contact.display_name,
    verified: contact.verified,
    ...(contact.subtitle ? { subtitle: contact.subtitle } : {}),
    ...(contact.description ? { description: contact.description.slice(0, 500) } : {}),
  };
}

export async function findAgents(
  relay: Pick<Relay, "contacts">,
  input: FindAgentsInput,
  options: RequestOptions = {},
): Promise<{ status: "found"; contacts: FoundContact[] } | { status: "not_found"; reason: string }> {
  try {
    const response = await relay.contacts.lookup(
      input.task !== undefined ? { task: input.task } : { handle: input.handle! },
      options,
    );
    const contacts = "contacts" in response ? response.contacts : [response.contact];
    return { status: "found", contacts: contacts.slice(0, 10).map(found) };
  } catch (error) {
    if (error instanceof RelayAPIError && error.status === 404) {
      return { status: "not_found", reason: `Relay said: ${error.message}` };
    }
    throw error;
  }
}

export const groupInputSchema = z.object({
  do: z.enum(["rename", "set_photo", "add_agent", "remove", "leave"]).describe(
    "rename names this group; set_photo sets its photo; add_agent adds an agent to it; remove takes a member out; "
    + "leave takes you out of it.",
  ),
  name: z.string().trim().min(1).max(255).optional().describe("With rename: the group's new name."),
  image_url: z.string().trim().max(2_048).regex(/^https:\/\/\S+$/u).optional().describe(
    "With set_photo: a public https image address for the group's photo.",
  ),
  handle: z.string().trim().min(1).max(255).optional().describe(
    "With add_agent and remove: the member's Relay Handle, without the @.",
  ),
}).strict().superRefine((value, context) => {
  const fields = { rename: "name", set_photo: "image_url", add_agent: "handle", remove: "handle", leave: undefined } as const;
  const needed = fields[value.do];
  for (const field of ["name", "image_url", "handle"] as const) {
    if (field === needed && value[field] === undefined) {
      context.addIssue({ code: "custom", path: [field], message: `${field} is required with ${value.do}` });
    }
    if (field !== needed && value[field] !== undefined) {
      context.addIssue({ code: "custom", path: [field], message: `${field} is not valid with ${value.do}` });
    }
  }
});
export type GroupInput = z.infer<typeof groupInputSchema>;

export type ChatActionResult = { status: "done" } | { status: "not_done"; reason: string };

/** Relay's 4xx refusals become facts in Relay's own words; the rest throws. */
async function refusalAsFact(operation: () => Promise<unknown>): Promise<ChatActionResult> {
  try {
    await operation();
    return { status: "done" };
  } catch (error) {
    const status = error instanceof RelayAPIError ? error.status ?? 0 : 0;
    if (status >= 400 && status < 500 && status !== 429) {
      return { status: "not_done", reason: `Relay did not do it: ${(error as Error).message}` };
    }
    throw error;
  }
}

export async function changeGroup(
  relay: Pick<Relay, "chats">,
  chatId: string,
  input: GroupInput,
  options: RequestOptions = {},
): Promise<ChatActionResult> {
  const chat = await relay.chats.retrieve(chatId, options);
  if (!chat.is_group) {
    return { status: "not_done", reason: "This is a one-to-one chat, not a group." };
  }
  return await refusalAsFact(() => {
    switch (input.do) {
      case "rename":
        return relay.chats.update(chatId, { display_name: input.name! }, options);
      case "set_photo":
        return relay.chats.update(chatId, { group_chat_icon: input.image_url! }, options);
      case "add_agent":
        return relay.chats.participants.add(chatId, { handle: input.handle! }, options);
      case "remove":
        return relay.chats.participants.remove(chatId, { handle: input.handle! }, options);
      case "leave":
        return relay.chats.leaveChat(chatId, options);
    }
  });
}

export async function shareContactCard(
  relay: Pick<Relay, "chats">,
  chatId: string,
  options: RequestOptions = {},
): Promise<ChatActionResult> {
  return await refusalAsFact(() => relay.chats.shareContactCard(chatId, options));
}
