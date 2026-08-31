export interface RelayV1Operation {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly operationId: string;
}

export const RELAY_V1_OPERATIONS = [
  {
    "method": "POST",
    "path": "/v1/chats",
    "operationId": "createChat"
  },
  {
    "method": "GET",
    "path": "/v1/chats",
    "operationId": "listChats"
  },
  {
    "method": "GET",
    "path": "/v1/chats/{chatId}",
    "operationId": "getChat"
  },
  {
    "method": "PUT",
    "path": "/v1/chats/{chatId}",
    "operationId": "updateChat"
  },
  {
    "method": "POST",
    "path": "/v1/chats/{chatId}/participants",
    "operationId": "addParticipant"
  },
  {
    "method": "DELETE",
    "path": "/v1/chats/{chatId}/participants",
    "operationId": "removeParticipant"
  },
  {
    "method": "POST",
    "path": "/v1/chats/{chatId}/leave",
    "operationId": "leaveChat"
  },
  {
    "method": "POST",
    "path": "/v1/chats/{chatId}/typing",
    "operationId": "startTyping"
  },
  {
    "method": "DELETE",
    "path": "/v1/chats/{chatId}/typing",
    "operationId": "stopTyping"
  },
  {
    "method": "POST",
    "path": "/v1/chats/{chatId}/read",
    "operationId": "markChatAsRead"
  },
  {
    "method": "POST",
    "path": "/v1/chats/{chatId}/share_contact_card",
    "operationId": "shareContactWithChat"
  },
  {
    "method": "POST",
    "path": "/v1/messages",
    "operationId": "sendMessage"
  },
  {
    "method": "POST",
    "path": "/v1/chats/{chatId}/messages",
    "operationId": "sendMessageToChat"
  },
  {
    "method": "GET",
    "path": "/v1/chats/{chatId}/messages",
    "operationId": "getMessages"
  },
  {
    "method": "GET",
    "path": "/v1/messages/{messageId}/thread",
    "operationId": "getMessageThread"
  },
  {
    "method": "POST",
    "path": "/v1/chats/{chatId}/voicememo",
    "operationId": "sendVoiceMemoToChat"
  },
  {
    "method": "GET",
    "path": "/v1/messages/{messageId}",
    "operationId": "getMessage"
  },
  {
    "method": "POST",
    "path": "/v1/messages/{messageId}/reactions",
    "operationId": "sendReaction"
  },
  {
    "method": "POST",
    "path": "/v1/attachments",
    "operationId": "requestUpload"
  },
  {
    "method": "GET",
    "path": "/v1/attachments/{attachmentId}",
    "operationId": "getAttachment"
  },
  {
    "method": "DELETE",
    "path": "/v1/attachments/{attachmentId}",
    "operationId": "deleteAttachment"
  },
  {
    "method": "GET",
    "path": "/v1/blocked_handles",
    "operationId": "listBlockedHandles"
  },
  {
    "method": "POST",
    "path": "/v1/blocked_handles",
    "operationId": "blockHandle"
  },
  {
    "method": "DELETE",
    "path": "/v1/blocked_handles",
    "operationId": "unblockHandle"
  },
  {
    "method": "GET",
    "path": "/v1/webhook-events",
    "operationId": "listWebhookEvents"
  },
  {
    "method": "POST",
    "path": "/v1/webhook-subscriptions",
    "operationId": "createWebhookSubscription"
  },
  {
    "method": "GET",
    "path": "/v1/webhook-subscriptions",
    "operationId": "listWebhookSubscriptions"
  },
  {
    "method": "GET",
    "path": "/v1/webhook-subscriptions/{subscriptionId}",
    "operationId": "getWebhookSubscription"
  },
  {
    "method": "PUT",
    "path": "/v1/webhook-subscriptions/{subscriptionId}",
    "operationId": "updateWebhookSubscription"
  },
  {
    "method": "DELETE",
    "path": "/v1/webhook-subscriptions/{subscriptionId}",
    "operationId": "deleteWebhookSubscription"
  },
  {
    "method": "GET",
    "path": "/v1/contact_card",
    "operationId": "getContactCard"
  },
  {
    "method": "POST",
    "path": "/v1/contact_card",
    "operationId": "setupContactCard"
  },
  {
    "method": "PATCH",
    "path": "/v1/contact_card",
    "operationId": "updateContactCard"
  },
  {
    "method": "POST",
    "path": "/v1/contact_requests",
    "operationId": "createContactRequest"
  }
] as const satisfies readonly RelayV1Operation[];

export const RELAY_WEBHOOK_EVENT_TYPES = [
  "message.sent",
  "message.received",
  "message.read",
  "message.delivered",
  "reaction.added",
  "reaction.removed",
  "participant.added",
  "participant.removed",
  "chat.created",
  "chat.group_name_updated",
  "chat.group_icon_updated",
  "chat.typing_indicator.started",
  "chat.typing_indicator.stopped",
  "contact.added",
  "contact.removed"
] as const;
