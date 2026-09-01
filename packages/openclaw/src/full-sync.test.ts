import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatsPage,
  MessagesPage,
  type Chat,
  type Message,
} from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import { commitRelayFullSync } from "./full-sync.js";
import { openRelayStateStore } from "./state.js";

const chat: Chat = {
  id: "00000000-0000-7000-8000-000000000001",
  display_name: "Test Chat",
  handles: [],
  is_group: false,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

const message: Message = {
  id: "00000000-0000-7000-8000-000000000002",
  chat_id: chat.id,
  is_system_message: false,
  is_from_me: false,
  delivery_status: "delivered",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

describe("Relay WebSocket FULL sync", () => {
  it("commits every Chat and visible Message before returning", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-full-sync-"));
    try {
      const state = openRelayStateStore({
        stateDir,
        accountId: "full-sync",
      });
      const relay = {
        chats: {
          listChats: async () =>
            new ChatsPage({ data: [chat], nextCursor: null }),
          messages: {
            list: async () =>
              new MessagesPage({ data: [message], nextCursor: null }),
          },
        },
      };
      await commitRelayFullSync({
        relay: relay as never,
        state,
        context: {
          throughSequence: "42",
          reason: "checkpoint_outside_retention",
        },
      });

      expect(await state.readSnapshot()).toMatchObject({
        version: 1,
        throughSequence: "42",
        reason: "checkpoint_outside_retention",
        chats: [{ chat, messages: [message] }],
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
