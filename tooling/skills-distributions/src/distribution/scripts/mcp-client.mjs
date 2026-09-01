import assert from "node:assert/strict";

const endpoint =
  process.env.RELAY_DOCS_MCP_URL ?? "https://docs.relayapp.im/mcp";

const decode = (body) => {
  const payloads = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(payloads.length, 1, "expected one MCP response payload");
  const payload = payloads[0];
  if (payload.error) {
    throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
  }
  return payload.result;
};

export const callMcp = async (method, params, id = 1) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `MCP HTTP ${response.status}`);
  return decode(await response.text());
};

export const searchRelay = async (query) => {
  const result = await callMcp(
    "tools/call",
    {
      name: "search_relay",
      arguments: { query },
    },
    3,
  );
  assert.ok(Array.isArray(result.content), "search result content is missing");
  return result.content.map((item) => item.text || "").join("\n");
};
