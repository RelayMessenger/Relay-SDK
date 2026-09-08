import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLISH_PROPAGATION,
  parseNpmViewIntegrity,
  verifyNpmRegistryIntegrity,
} from "./verify-npm-registry-integrity.mjs";

const INTEGRITY = "sha512-KGueJoxP7WKe4n8Z1Ioz7unCSWjm/2hJHF1kHTwfs9WtYqIfyk369unzBdkNGvkXTYlWNSnNhr9hPrKQ92/8lQ==";
const OTHER = "sha512-Db1gn5iQ7ZNrGHPudE4gRW+3H1w4tCluAkGAvXAxyJMBBScySa622BaKpTilmNP7vRFxzoL4tM65n8So0QY/KA==";
const absent = { error: "npm error code E404\nnpm error 404 Not Found" };

function harness(answers) {
  const calls = [];
  const sleeps = [];
  return {
    calls,
    sleeps,
    options: {
      packageSpec: "@relaymessenger/openclaw-plugin@0.4.1-staging.0",
      expectedIntegrity: INTEGRITY,
      query: (spec) => {
        calls.push(spec);
        return answers[Math.min(calls.length, answers.length) - 1];
      },
      sleep: async (delay) => {
        sleeps.push(delay);
      },
      log: () => {},
    },
  };
}

test("a publish that exited 0 and reads back only after retries is a success", async () => {
  // The 2026-09-07 case: npm answered the publish, then served E404 for longer
  // than one read, then exposed the tarball this run packed.
  const { options, calls, sleeps } = harness([absent, absent, absent, { integrity: INTEGRITY }]);
  const seen = await verifyNpmRegistryIntegrity({ ...options, maxAttempts: 6, retryDelayMs: 7 });
  assert.equal(seen, INTEGRITY);
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [7, 7, 7]);
});

test("a different tarball under the same version fails closed at once", async () => {
  const { options, sleeps } = harness([absent, { integrity: OTHER }]);
  await assert.rejects(
    verifyNpmRegistryIntegrity({ ...options, maxAttempts: 6, retryDelayMs: 1 }),
    /registry integrity .* != retained artifact/u,
  );
  assert.deepEqual(sleeps, [1]);
});

test("silence past the budget fails, naming the attempts", async () => {
  const { options, calls } = harness([absent]);
  await assert.rejects(
    verifyNpmRegistryIntegrity({ ...options, maxAttempts: 3, retryDelayMs: 0 }),
    /did not expose .* after 3 attempts/u,
  );
  assert.equal(calls.length, 3);
});

test("an error other than 404 is not propagation and stops the wait", async () => {
  const { options, calls } = harness([{ error: "npm error code E401 unauthorized" }]);
  await assert.rejects(
    verifyNpmRegistryIntegrity({ ...options, maxAttempts: 5, retryDelayMs: 0 }),
    /npm view failed/u,
  );
  assert.equal(calls.length, 1);
});

test("the shared budget covers npm's 'a few minutes' of processing", () => {
  assert.ok(
    PUBLISH_PROPAGATION.maxAttempts * PUBLISH_PROPAGATION.retryDelayMs >= 5 * 60_000,
    "less than five minutes of propagation wait",
  );
  assert.ok(Object.isFrozen(PUBLISH_PROPAGATION));
});

test("npm 12's single-element array and npm 11's string both parse", () => {
  assert.equal(parseNpmViewIntegrity(JSON.stringify([INTEGRITY])), INTEGRITY);
  assert.equal(parseNpmViewIntegrity(JSON.stringify(INTEGRITY)), INTEGRITY);
  assert.throws(() => parseNpmViewIntegrity("[]"), /unexpected integrity shape/u);
});
