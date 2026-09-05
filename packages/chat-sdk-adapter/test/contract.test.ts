import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  RELAY_API_VERSION,
  RELAY_WEBHOOK_EVENT_TYPES,
  RELAY_WEBHOOK_VERSION,
} from "../src/index.js";

const OPENAPI_SHA =
  "691f75e9c300cb6ad46109872939cdb2d7cd5ab5839b2c174152fe739161a305";

interface PackageIdentity {
  bugs: { url: string };
  repository: {
    type: string;
    url: string;
    directory: string;
  };
}

interface OpenApiDocument {
  components: {
    schemas: Record<string, Record<string, unknown>>;
  };
  paths: Record<string, Record<string, unknown>>;
  servers: Array<{ url: string }>;
}

describe("locked Relay Server contract", () => {
  it("publishes from the canonical Relay-SDK package directory", async () => {
    const packageJson = JSON.parse(
      await readFile(
        new URL("../package.json", import.meta.url),
        "utf8",
      ),
    ) as PackageIdentity;
    const source = JSON.parse(
      await readFile(
        new URL("../SOURCE.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, string>;
    const sourceLock = JSON.parse(
      await readFile(
        new URL("../../../sources.lock.json", import.meta.url),
        "utf8",
      ),
    ) as {
      imports: Record<string, Record<string, string>>;
    };
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/RelayMessenger/Relay-SDK.git",
      directory: "packages/chat-sdk-adapter",
    });
    expect(packageJson.bugs).toEqual({
      url: "https://github.com/RelayMessenger/Relay-SDK/issues",
    });
    expect(source).toEqual({
      ...sourceLock.imports["packages/chat-sdk-adapter"],
      imported_at: "2026-09-01",
      canonical: "Relay-SDK",
    });
  });

  it("uses the exact canonical Server OpenAPI", async () => {
    const source = await readFile(
      new URL("../contracts/relay-openapi.yaml", import.meta.url),
    );
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      OPENAPI_SHA,
    );
  });

  it("pins only public methods the adapter calls", async () => {
    const document = parse(
      await readFile(
        new URL("../contracts/relay-openapi.yaml", import.meta.url),
        "utf8",
      ),
    ) as OpenApiDocument;
    expect(document.servers[0]?.url).toBe(
      "https://api.relayapp.im",
    );
    expect(
      Object.keys(
        document.paths["/v1/chats/{chatId}/messages"] ?? {},
      ),
    ).toEqual(expect.arrayContaining(["get", "post"]));
    expect(
      Object.keys(
        document.paths["/v1/chats/{chatId}/typing"] ?? {},
      ),
    ).toEqual(expect.arrayContaining(["post", "delete"]));
    expect(
      document.paths["/v1/chats/{chatId}/read"],
    ).toHaveProperty("post");
    expect(
      document.paths["/v1/messages/{messageId}/reactions"],
    ).toHaveProperty("post");
    expect(document.paths["/v1/attachments"]).toHaveProperty(
      "post",
    );
    expect(document.paths["/v1/messages/{messageId}"]).toHaveProperty(
      "get",
    );
    // Edit and unsend joined the contract on Relay Server f14c368b. The
    // adapter does not call either, because the Chat SDK has no operation
    // for a Message the sender changed after sending it.
    expect(document.paths["/v1/messages/{messageId}"]).toHaveProperty(
      "patch",
    );
    expect(document.paths["/v1/messages/{messageId}"]).toHaveProperty(
      "delete",
    );
    const chatHandle = document.components.schemas.ChatHandle as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(chatHandle.required).toEqual(expect.arrayContaining([
      "image_url",
      "about",
    ]));
    expect(chatHandle.required).not.toContain("avatar_url");
    expect(chatHandle.required).not.toContain("tagline");
    expect(chatHandle.properties).toHaveProperty("image_url");
    expect(chatHandle.properties).toHaveProperty("about");
    expect(chatHandle.properties).not.toHaveProperty("avatar_url");
    expect(chatHandle.properties).not.toHaveProperty("tagline");
  });

  it("keeps API/webhook versions and every event synchronized", async () => {
    const document = parse(
      await readFile(
        new URL("../contracts/relay-openapi.yaml", import.meta.url),
        "utf8",
      ),
    ) as OpenApiDocument;
    const envelope = document.components.schemas.WebhookEnvelopeBase as {
      properties: {
        api_version: { enum: string[] };
        webhook_version: { enum: string[] };
      };
    };
    const events = document.components.schemas.WebhookEventType as {
      enum: string[];
    };
    expect(envelope.properties.api_version.enum).toEqual([
      RELAY_API_VERSION,
    ]);
    expect(envelope.properties.webhook_version.enum).toEqual([
      RELAY_WEBHOOK_VERSION,
    ]);
    expect(events.enum).toEqual([...RELAY_WEBHOOK_EVENT_TYPES]);
  });
});
