import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import Relay, {
  type ContactCardCreateParams,
  type ContactCardUpdateParams,
  type MessageAddReactionParams,
  type MessageContent,
  type MessageCreateParams,
  type MessageSendParams,
} from "@relaymessenger/sdk";
import { z } from "zod";
import type { AuthContext } from "./auth.js";
import { collectLocalTokens, resolveAgentAuth } from "./auth.js";
import { safeErrorMessage } from "./redact.js";

export interface ResolvedRelayClient {
  client: Relay;
  secrets?: string[];
}

export interface RelayMcpServerOptions {
  authContext?: AuthContext;
  resolveClient?: () => Promise<ResolvedRelayClient>;
  collectSecrets?: () => Promise<string[]>;
}

const uuid = z.uuid();
const cursor = z.string().min(1).max(512).optional();
const limit = z.number().int().min(1).max(100).optional();
const relayHandle = z.string()
  .min(1)
  .max(128)
  .regex(/^[^@\s]+$/, "Omit the leading @ and whitespace.");
const idempotencyKey = z.string().min(1).max(255);
const messageText = z.string().min(1).max(32_000);

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const idempotentWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const serializableObject = (value: unknown): Record<string, unknown> => {
  const normalized = value === undefined ? { ok: true } : value;
  const serialized = JSON.stringify(normalized);
  const parsed = JSON.parse(serialized) as unknown;
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { result: parsed };
};

const success = (value: unknown): CallToolResult => {
  const structuredContent = serializableObject(value);
  return {
    content: [{
      type: "text",
      text: JSON.stringify(structuredContent, null, 2),
    }],
    structuredContent,
  };
};

const textMessage = (
  text: string,
  stableKey: string,
): MessageContent => ({
  parts: [{ type: "text", value: text }],
  idempotency_key: stableKey,
});

const operation = async (
  options: Required<
    Pick<RelayMcpServerOptions, "resolveClient" | "collectSecrets">
  >,
  callback: (client: Relay) => Promise<unknown>,
): Promise<CallToolResult> => {
  let secrets: string[] = [];
  try {
    secrets = await options.collectSecrets();
  } catch {
    // Continue: a malformed local config must not break a custom resolver.
  }
  try {
    const resolved = await options.resolveClient();
    secrets.push(...(resolved.secrets ?? []));
    return success(await callback(resolved.client));
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Relay tool failed: ${safeErrorMessage(error, secrets)}`,
      }],
      isError: true,
    };
  }
};

export const createRelayMcpServer = (
  options: RelayMcpServerOptions = {},
): McpServer => {
  const authContext = options.authContext ?? {};
  const dependencies = {
    resolveClient: options.resolveClient ?? (async () => {
      const auth = await resolveAgentAuth(authContext);
      return {
        client: new Relay({
          apiKey: auth.token,
          baseURL: auth.apiURL,
        }),
        secrets: [auth.token],
      };
    }),
    collectSecrets: options.collectSecrets
      ?? (() => collectLocalTokens(authContext)),
  };

  const server = new McpServer(
    {
      name: "relay",
      version: "0.1.0-staging.2",
    },
    {
      capabilities: { tools: {} },
      instructions:
        "Use explicit Relay tools. Message sends require stable idempotency keys. "
        + "Agent authentication is resolved locally and is never a tool argument.",
    },
  );

  server.registerTool(
    "relay_list_chats",
    {
      title: "List Relay Chats",
      description: "List Chats visible to the authenticated Relay Agent.",
      inputSchema: z.object({ cursor, limit }),
      annotations: readAnnotations,
    },
    async (args) => operation(dependencies, async (client) => {
      const page = await client.chats.listChats({
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      return { chats: page.chats, next_cursor: page.nextCursor };
    }),
  );

  server.registerTool(
    "relay_get_chat",
    {
      title: "Get Relay Chat",
      description: "Retrieve one Relay Chat by ID.",
      inputSchema: z.object({ chat_id: uuid }),
      annotations: readAnnotations,
    },
    async ({ chat_id }) => operation(
      dependencies,
      (client) => client.chats.retrieve(chat_id),
    ),
  );

  server.registerTool(
    "relay_list_messages",
    {
      title: "List Relay Messages",
      description: "List Messages in one Relay Chat.",
      inputSchema: z.object({ chat_id: uuid, cursor, limit }),
      annotations: readAnnotations,
    },
    async ({ chat_id, cursor: next, limit: pageSize }) => operation(
      dependencies,
      async (client) => {
        const page = await client.chats.messages.list(chat_id, {
          ...(next ? { cursor: next } : {}),
          ...(pageSize === undefined ? {} : { limit: pageSize }),
        });
        return { messages: page.messages, next_cursor: page.nextCursor };
      },
    ),
  );

  server.registerTool(
    "relay_get_message",
    {
      title: "Get Relay Message",
      description: "Retrieve one Relay Message by ID.",
      inputSchema: z.object({ message_id: uuid }),
      annotations: readAnnotations,
    },
    async ({ message_id }) => operation(
      dependencies,
      (client) => client.messages.retrieve(message_id),
    ),
  );

  server.registerTool(
    "relay_get_message_thread",
    {
      title: "Get Relay Message Thread",
      description: "List the thread rooted at one Relay Message.",
      inputSchema: z.object({
        message_id: uuid,
        cursor,
        limit,
        order: z.enum(["asc", "desc"]).optional(),
      }),
      annotations: readAnnotations,
    },
    async ({ message_id, cursor: next, limit: pageSize, order }) => operation(
      dependencies,
      async (client) => {
        const page = await client.messages.listMessagesThread(message_id, {
          ...(next ? { cursor: next } : {}),
          ...(pageSize === undefined ? {} : { limit: pageSize }),
          ...(order ? { order } : {}),
        });
        return { messages: page.messages, next_cursor: page.nextCursor };
      },
    ),
  );

  server.registerTool(
    "relay_send_message",
    {
      title: "Send Relay Message",
      description:
        "Resolve or create a Chat and send a text Message to Relay Handles. "
        + "Reuse the same idempotency key only for the same logical send.",
      inputSchema: z.object({
        recipients: z.array(relayHandle).min(1).max(31),
        text: messageText,
        idempotency_key: idempotencyKey,
      }),
      annotations: idempotentWriteAnnotations,
    },
    async ({ recipients, text, idempotency_key }) => operation(
      dependencies,
      (client) => {
        const body = {
          to: recipients,
          message: textMessage(text, idempotency_key),
        } satisfies MessageCreateParams;
        return client.messages.create(body);
      },
    ),
  );

  server.registerTool(
    "relay_send_message_to_chat",
    {
      title: "Send Message to Relay Chat",
      description:
        "Send a text Message to a known Relay Chat. Reuse the idempotency key "
        + "only for the same logical send.",
      inputSchema: z.object({
        chat_id: uuid,
        text: messageText,
        idempotency_key: idempotencyKey,
      }),
      annotations: idempotentWriteAnnotations,
    },
    async ({ chat_id, text, idempotency_key }) => operation(
      dependencies,
      (client) => {
        const body = {
          message: textMessage(text, idempotency_key),
        } satisfies MessageSendParams;
        return client.chats.messages.send(chat_id, body);
      },
    ),
  );

  const reactionInput = z.object({
    message_id: uuid,
    operation: z.enum(["add", "remove"]),
    type: z.enum([
      "love",
      "like",
      "dislike",
      "laugh",
      "emphasize",
      "question",
      "custom",
    ]),
    custom_emoji: z.string().min(1).max(32).optional(),
    part_index: z.number().int().min(0).optional(),
  }).superRefine((value, context) => {
    if (value.type === "custom" && !value.custom_emoji) {
      context.addIssue({
        code: "custom",
        message: "custom_emoji is required when type is custom.",
        path: ["custom_emoji"],
      });
    }
    if (value.type !== "custom" && value.custom_emoji) {
      context.addIssue({
        code: "custom",
        message: "custom_emoji is allowed only when type is custom.",
        path: ["custom_emoji"],
      });
    }
  });
  server.registerTool(
    "relay_react_to_message",
    {
      title: "React to Relay Message",
      description: "Add or remove a reaction on a Relay Message part.",
      inputSchema: reactionInput,
      annotations: destructiveAnnotations,
    },
    async ({ message_id, operation: reactionOperation, type, custom_emoji, part_index }) =>
      operation(dependencies, (client) => {
        const body = {
          operation: reactionOperation,
          type,
          ...(custom_emoji ? { custom_emoji } : {}),
          ...(part_index === undefined ? {} : { part_index }),
        } satisfies MessageAddReactionParams;
        return client.messages.addReaction(message_id, body);
      }),
  );

  server.registerTool(
    "relay_start_typing",
    {
      title: "Start Relay Typing",
      description: "Start or refresh the Agent typing indicator in a Chat.",
      inputSchema: z.object({ chat_id: uuid }),
      annotations: idempotentWriteAnnotations,
    },
    async ({ chat_id }) => operation(dependencies, async (client) => {
      await client.chats.startTyping(chat_id);
      return { ok: true };
    }),
  );

  server.registerTool(
    "relay_stop_typing",
    {
      title: "Stop Relay Typing",
      description: "Stop the Agent typing indicator in a Chat.",
      inputSchema: z.object({ chat_id: uuid }),
      annotations: idempotentWriteAnnotations,
    },
    async ({ chat_id }) => operation(dependencies, async (client) => {
      await client.chats.stopTyping(chat_id);
      return { ok: true };
    }),
  );

  server.registerTool(
    "relay_mark_chat_read",
    {
      title: "Mark Relay Chat Read",
      description: "Mark the visible Relay Chat as read by the Agent.",
      inputSchema: z.object({ chat_id: uuid }),
      annotations: idempotentWriteAnnotations,
    },
    async ({ chat_id }) => operation(dependencies, async (client) => {
      await client.chats.markAsRead(chat_id);
      return { ok: true };
    }),
  );

  server.registerTool(
    "relay_get_contact_card",
    {
      title: "Get Relay Contact Card",
      description: "Retrieve the authenticated Agent's Relay Contact Card.",
      inputSchema: z.object({ handle: relayHandle.optional() }),
      annotations: readAnnotations,
    },
    async ({ handle }) => operation(
      dependencies,
      (client) => client.contactCard.retrieve(handle ? { handle } : {}),
    ),
  );

  server.registerTool(
    "relay_set_contact_card",
    {
      title: "Set Relay Contact Card",
      description: "Create or replace the authenticated Agent's Contact Card.",
      inputSchema: z.object({
        handle: relayHandle,
        first_name: z.string().min(1).max(128),
        last_name: z.string().max(128).optional(),
        image_url: z.url().optional(),
      }),
      annotations: writeAnnotations,
    },
    async ({ handle, first_name, last_name, image_url }) => operation(
      dependencies,
      (client) => {
        const body = {
          handle,
          first_name,
          ...(last_name === undefined ? {} : { last_name }),
          ...(image_url === undefined ? {} : { image_url }),
        } satisfies ContactCardCreateParams;
        return client.contactCard.create(body);
      },
    ),
  );

  const updateContactCardInput = z.object({
    handle: relayHandle,
    first_name: z.string().min(1).max(128).optional(),
    last_name: z.string().max(128).nullable().optional(),
    image_url: z.url().nullable().optional(),
  }).refine(
    (value) =>
      value.first_name !== undefined
      || value.last_name !== undefined
      || value.image_url !== undefined,
    { message: "At least one Contact Card field must be updated." },
  );
  server.registerTool(
    "relay_update_contact_card",
    {
      title: "Update Relay Contact Card",
      description: "Update selected fields on the authenticated Agent's Contact Card.",
      inputSchema: updateContactCardInput,
      annotations: writeAnnotations,
    },
    async ({ handle, first_name, last_name, image_url }) => operation(
      dependencies,
      (client) => {
        const body = {
          handle,
          ...(first_name === undefined ? {} : { first_name }),
          ...(last_name === undefined ? {} : { last_name }),
          ...(image_url === undefined ? {} : { image_url }),
        } satisfies ContactCardUpdateParams;
        return client.contactCard.update(body);
      },
    ),
  );

  server.registerTool(
    "relay_share_contact_card",
    {
      title: "Share Relay Contact Card",
      description: "Share the authenticated Agent's configured Contact Card into a Chat.",
      inputSchema: z.object({ chat_id: uuid }),
      annotations: writeAnnotations,
    },
    async ({ chat_id }) => operation(dependencies, async (client) => {
      await client.chats.shareContactCard(chat_id);
      return { ok: true };
    }),
  );

  server.registerTool(
    "relay_create_contact_request",
    {
      title: "Create Relay Contact Request",
      description: "Ask a Relay user to add the authenticated premium-handle Agent.",
      inputSchema: z.object({ handle: relayHandle }),
      annotations: writeAnnotations,
    },
    async ({ handle }) => operation(
      dependencies,
      (client) => client.contactRequests.create({ handle }),
    ),
  );

  return server;
};
