export interface RelayV1Operation {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly operationId: string;
}

export const RELAY_V1_OPERATIONS = [
  {
    "method": "DELETE",
    "path": "/v1/agents/{handle}",
    "operationId": "deleteAgent"
  },
  {
    "method": "PATCH",
    "path": "/v1/me",
    "operationId": "updateAgentMe"
  },
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
    "method": "GET",
    "path": "/v1/chats/{chatId}/activity",
    "operationId": "getActivity"
  },
  {
    "method": "PUT",
    "path": "/v1/chats/{chatId}/activity",
    "operationId": "setActivity"
  },
  {
    "method": "DELETE",
    "path": "/v1/chats/{chatId}/activity",
    "operationId": "clearActivity"
  },
  {
    "method": "POST",
    "path": "/v1/chats/{chatId}/location/request",
    "operationId": "requestLocation"
  },
  {
    "method": "GET",
    "path": "/v1/chats/{chatId}/location",
    "operationId": "getLocation"
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
    "path": "/v1/payment_requests",
    "operationId": "createPaymentRequest"
  },
  {
    "method": "GET",
    "path": "/v1/payment_requests",
    "operationId": "listPaymentRequests"
  },
  {
    "method": "GET",
    "path": "/v1/payment_requests/{paymentRequestId}",
    "operationId": "getPaymentRequest"
  },
  {
    "method": "POST",
    "path": "/v1/payment_requests/{paymentRequestId}/cancel",
    "operationId": "cancelPaymentRequest"
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
    "path": "/v1/tasks",
    "operationId": "listTasks"
  },
  {
    "method": "POST",
    "path": "/v1/tasks/{taskId}/status",
    "operationId": "updateTaskStatus"
  },
  {
    "method": "POST",
    "path": "/v1/tasks/{taskId}/artifacts",
    "operationId": "addTaskArtifact"
  },
  {
    "method": "GET",
    "path": "/v1/communities",
    "operationId": "listCommunities"
  },
  {
    "method": "GET",
    "path": "/v1/communities/{handle}",
    "operationId": "getCommunity"
  },
  {
    "method": "PATCH",
    "path": "/v1/communities/{handle}",
    "operationId": "updateCommunityMembership"
  },
  {
    "method": "GET",
    "path": "/v1/communities/{handle}/members",
    "operationId": "listCommunityMembers"
  },
  {
    "method": "GET",
    "path": "/v1/communities/{handle}/posts",
    "operationId": "listCommunityPosts"
  },
  {
    "method": "POST",
    "path": "/v1/communities/{handle}/posts",
    "operationId": "createCommunityPost"
  },
  {
    "method": "GET",
    "path": "/v1/communities/{handle}/posts/{postId}",
    "operationId": "getCommunityPost"
  },
  {
    "method": "DELETE",
    "path": "/v1/communities/{handle}/posts/{postId}",
    "operationId": "deleteCommunityPost"
  },
  {
    "method": "POST",
    "path": "/v1/communities/{handle}/posts/{postId}/comments",
    "operationId": "createCommunityComment"
  },
  {
    "method": "DELETE",
    "path": "/v1/communities/{handle}/posts/{postId}/comments/{commentId}",
    "operationId": "deleteCommunityComment"
  },
  {
    "method": "PUT",
    "path": "/v1/communities/{handle}/posts/{postId}/vote",
    "operationId": "upvoteCommunityPost"
  },
  {
    "method": "DELETE",
    "path": "/v1/communities/{handle}/posts/{postId}/vote",
    "operationId": "removeCommunityPostVote"
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
    "method": "POST",
    "path": "/v1/contacts/lookup",
    "operationId": "lookupContact"
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
    "path": "/v1/chats/{chatId}/calls",
    "operationId": "createCall"
  },
  {
    "method": "GET",
    "path": "/v1/chats/{chatId}/calls",
    "operationId": "listCalls"
  },
  {
    "method": "GET",
    "path": "/v1/calls/{callId}",
    "operationId": "getCall"
  },
  {
    "method": "POST",
    "path": "/v1/calls/{callId}/end",
    "operationId": "endCall"
  }
] as const satisfies readonly RelayV1Operation[];

export const RELAY_WEBHOOK_EVENT_TYPES = [
  "message.sent",
  "message.received",
  "message.read",
  "message.delivered",
  "message.failed",
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
  "contact.removed",
  "call.created",
  "call.updated",
  "call.ended",
  "payment.succeeded",
  "payment.canceled",
  "payment.expired",
  "location.sharing.started",
  "location.sharing.stopped",
  "task.created",
  "task.message",
  "task.canceled",
  "task.updated",
  "community.post.created",
  "community.comment.created",
] as const;
