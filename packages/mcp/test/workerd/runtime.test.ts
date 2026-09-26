import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Relay MCP on workerd", () => {
  it("boots the server and runs one TypeScript execute call end to end", async () => {
    const response = await exports.default.fetch("https://example.test/");
    expect(response.status).toBe(200);
    const outcome = await response.json() as {
      result: { isError?: boolean; structuredContent?: { result?: unknown } };
      requests: string[];
    };
    expect(outcome.result.isError).not.toBe(true);
    expect(outcome.result.structuredContent?.result).toBe("workerd");
    expect(outcome.requests).toEqual(["https://api.relay.test/v1/contact_card"]);
  });

  const inDynamicWorker = async (code: string) => {
    const response = await exports.default.fetch("https://example.test/executor", { method: "POST", body: code });
    expect(response.status).toBe(200);
    return await response.json() as {
      result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { result?: unknown; logs?: Array<{ level: string; text: string }> } };
      requests: string[];
    };
  };

  it("runs execute in a Dynamic Worker through Code Mode's executor, calling Relay only from the host", async () => {
    const outcome = await inDynamicWorker(
      "async function run(client) { const card: { handle: string } = await client.contactCard.retrieve(); console.log('saw', { handle: card.handle }); return card.handle; }",
    );
    expect(outcome.result.isError).not.toBe(true);
    expect(outcome.result.structuredContent?.result).toBe("workerd");
    expect(outcome.result.structuredContent?.logs).toEqual([{ level: "log", text: 'saw {"handle":"workerd"}' }]);
    expect(outcome.requests).toEqual(["https://api.relay.test/v1/contact_card"]);
  });

  it("gives the Dynamic Worker the SDK's error status and no network or credential", async () => {
    const outcome = await inDynamicWorker(`async function run(client) {
      let status = null;
      try { await client.chats.retrieve("missing"); } catch (error: any) { status = error.status; }
      let network = "open";
      try { await fetch("https://example.com/"); } catch (error: any) { network = String(error.message); }
      return { status, network, token: JSON.stringify(Object.getOwnPropertyNames(globalThis)).includes("rel_") };
    }`);
    expect(outcome.result.isError).not.toBe(true);
    const result = outcome.result.structuredContent?.result as { status: number; network: string; token: boolean };
    expect(result.status).toBe(404);
    expect(result.network).toMatch(/not permitted to access the internet/u);
    expect(result.token).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("rel_workerd_test_token_never_shown");
  });
});
