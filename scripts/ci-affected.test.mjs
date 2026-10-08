import assert from "node:assert/strict";
import test from "node:test";
import { legs, select } from "./ci-affected.mjs";

const every = Object.keys(legs);
const pr = files => select({ event: "pull_request", baseRef: "staging", files }).legs;

test("pushes and pull requests into main run every leg and the release rehearsals", () => {
  assert.deepEqual(select({ event: "push", files: [] }), { legs: every, release: true });
  assert.deepEqual(select({ event: "pull_request", baseRef: "main", files: ["packages/pi/src/index.ts"] }), { legs: every, release: true });
});

test("a pull request into staging runs the touched workspace and its dependents only", () => {
  assert.deepEqual(pr(["packages/pi/src/index.ts"]), ["workflows", "cli"]);
  assert.deepEqual(pr(["packages/openclaw/src/index.ts"]), ["workflows", "openclaw"]);
  assert.deepEqual(pr(["packages/chat-sdk-adapter/src/index.ts"]), ["workflows", "chat-sdk", "cookbook"]);
  assert.deepEqual(pr(["packages/sdk/src/index.ts"]), every);
  assert.equal(select({ event: "pull_request", baseRef: "staging", files: ["packages/pi/src/index.ts"] }).release, false);
});

test("root files run everything; notes and Python run no Node leg", () => {
  assert.deepEqual(select({ event: "pull_request", baseRef: "staging", files: ["package-lock.json"] }), { legs: every, release: true });
  assert.deepEqual(pr(["AGENTS.md"]), []);
  assert.deepEqual(pr(["python/relaymessenger/src/relaymessenger/__init__.py"]), ["workflows"]);
});
