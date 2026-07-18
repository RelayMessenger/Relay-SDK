import { describe, expect, it } from "vitest";
import { normalizeRelayBaseUrl } from "./client.js";

describe("Relay API origin safety", () => {
  it("canonicalizes equivalent HTTPS origins", () => {
    expect(normalizeRelayBaseUrl(" HTTPS://API.RELAYAPP.IM:443/ ")).toBe(
      "https://api.relayapp.im",
    );
    expect(normalizeRelayBaseUrl("https://relay.example.test:8443")).toBe(
      "https://relay.example.test:8443",
    );
    expect(normalizeRelayBaseUrl("https://api.relayapp.im////")).toBe(
      "https://api.relayapp.im",
    );
  });

  it("allows explicit loopback HTTP for local harnesses", () => {
    expect(normalizeRelayBaseUrl("http://127.0.0.1:8790/")).toBe("http://127.0.0.1:8790");
    expect(normalizeRelayBaseUrl("http://localhost:8790")).toBe("http://localhost:8790");
    expect(normalizeRelayBaseUrl("http://[::1]:8790")).toBe("http://[::1]:8790");
  });

  it("rejects token-bearing requests to insecure remote HTTP origins", () => {
    expect(() => normalizeRelayBaseUrl("http://api.relayapp.im")).toThrow(/must use HTTPS/);
    expect(() => normalizeRelayBaseUrl("http://192.168.1.5:8790")).toThrow(/must use HTTPS/);
    expect(() => normalizeRelayBaseUrl("http://127.example.test:8790")).toThrow(/must use HTTPS/);
  });

  it("rejects credentials, paths, queries, and fragments", () => {
    expect(() => normalizeRelayBaseUrl("https://user:secret@api.relayapp.im")).toThrow(
      /credentials/,
    );
    expect(() => normalizeRelayBaseUrl("https://api.relayapp.im/proxy")).toThrow(/without a path/);
    expect(() => normalizeRelayBaseUrl("https://api.relayapp.im?env=prod")).toThrow(/query/);
    expect(() => normalizeRelayBaseUrl("https://api.relayapp.im#token")).toThrow(/fragment/);
  });
});
