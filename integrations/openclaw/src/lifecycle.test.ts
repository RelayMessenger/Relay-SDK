import { describe, expect, it } from "vitest";
import { createRelayAccountLifecycleRegistry } from "./lifecycle.js";

describe("Relay account lifecycle", () => {
  it("aborts an active account when the gateway stops it", () => {
    const registry = createRelayAccountLifecycleRegistry();
    const lease = registry.acquire("default", new AbortController().signal);
    expect(lease.signal.aborted).toBe(false);
    expect(registry.stop("default")).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });

  it("does not allow a replacement consumer until teardown releases ownership", () => {
    const registry = createRelayAccountLifecycleRegistry();
    const lease = registry.acquire("default", new AbortController().signal);
    registry.stop("default");
    expect(() => registry.acquire("default", new AbortController().signal)).toThrow(
      /already has an active consumer/,
    );
    lease.release();
    expect(() => registry.acquire("default", new AbortController().signal)).not.toThrow();
  });

  it("also follows the gateway supervisor's parent abort signal", () => {
    const registry = createRelayAccountLifecycleRegistry();
    const parent = new AbortController();
    const lease = registry.acquire("named", parent.signal);
    parent.abort();
    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });
});
