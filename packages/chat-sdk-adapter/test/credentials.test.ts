import {
  AuthenticationError,
  ValidationError,
} from "@chat-adapter/shared";
import { describe, expect, it, vi } from "vitest";
import {
  resolveRelayCredential,
  validateStaticCredential,
} from "../src/index.js";

describe("Relay credentials", () => {
  it("resolves rotating credentials each time", async () => {
    const resolver = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    await expect(
      resolveRelayCredential(resolver, "token"),
    ).resolves.toBe("first");
    await expect(
      resolveRelayCredential(resolver, "token"),
    ).resolves.toBe("second");
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("rejects empty and failed resolver results", async () => {
    await expect(
      resolveRelayCredential(() => "", "token"),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
      resolveRelayCredential(
        () => Promise.reject(new Error("provider down")),
        "token",
      ),
    ).rejects.toThrow(/provider down/);
  });

  it("fails fast for an empty static credential", () => {
    expect(() => validateStaticCredential("", "token")).toThrow(
      ValidationError,
    );
  });
});
