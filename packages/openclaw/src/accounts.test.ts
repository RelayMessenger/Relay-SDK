import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELAY_BASE_URL,
  resolveRelayAccount,
} from "./accounts.js";
import type { RelayCoreConfig } from "./types.js";

describe("Relay accounts", () => {
  it("resolves the default account from the Agent Token environment variable", () => {
    const account = resolveRelayAccount({
      cfg: {} as RelayCoreConfig,
      env: { RELAY_AGENT_TOKEN: "rly_test" },
    });
    expect(account).toMatchObject({
      accountId: "default",
      configured: true,
      token: "rly_test",
      baseUrl: DEFAULT_RELAY_BASE_URL,
    });
  });

  it("keeps the environment credential boundary default-only", () => {
    const cfg = {
      channels: {
        relay: {
          accounts: {
            support: { name: "Support" },
          },
        },
      },
    } as RelayCoreConfig;
    const defaultAccount = resolveRelayAccount({
      cfg,
      env: { RELAY_AGENT_TOKEN: "rly_default" },
    });
    const namedAccount = resolveRelayAccount({
      cfg,
      accountId: "support",
      env: { RELAY_AGENT_TOKEN: "rly_default" },
    });
    expect(defaultAccount.token).toBe("rly_default");
    expect(namedAccount.configured).toBe(false);
    expect(namedAccount.token).toBe("");
  });

  it("keeps inline credentials out of named account inheritance", () => {
    const cfg = {
      channels: {
        relay: {
          token: "rly_default_inline",
          allowFrom: ["alice"],
          accounts: {
            support: { name: "Support" },
            billing: { token: "rly_billing_inline" },
          },
        },
      },
    } as RelayCoreConfig;
    const support = resolveRelayAccount({
      cfg,
      accountId: "support",
      env: {},
    });
    const billing = resolveRelayAccount({
      cfg,
      accountId: "billing",
      env: {},
    });
    expect(support).toMatchObject({
      configured: false,
      token: "",
      allowFrom: ["alice"],
    });
    expect(support.config.token).toBeUndefined();
    expect(billing.token).toBe("rly_billing_inline");
  });

  it("keeps tokenFile credentials out of named account inheritance", () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-account-secrets-"));
    try {
      const defaultTokenFile = join(directory, "default");
      const supportTokenFile = join(directory, "support");
      writeFileSync(defaultTokenFile, "rly_default_file\n", { mode: 0o600 });
      writeFileSync(supportTokenFile, "rly_support_file\n", { mode: 0o600 });
      const cfg = {
        channels: {
          relay: {
            tokenFile: defaultTokenFile,
            accounts: {
              support: { name: "Support" },
              explicit: { tokenFile: supportTokenFile },
            },
          },
        },
      } as RelayCoreConfig;

      const defaultAccount = resolveRelayAccount({ cfg, env: {} });
      const support = resolveRelayAccount({
        cfg,
        accountId: "support",
        env: {},
      });
      const explicit = resolveRelayAccount({
        cfg,
        accountId: "explicit",
        env: {},
      });
      expect(defaultAccount.token).toBe("rly_default_file");
      expect(support.configured).toBe(false);
      expect(support.config.tokenFile).toBeUndefined();
      expect(explicit.token).toBe("rly_support_file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("canonicalizes origins and permits HTTP only on loopback", () => {
    const account = resolveRelayAccount({
      cfg: {
        channels: {
          relay: {
            token: "rly_test",
            baseUrl: "HTTPS://API.RELAYAPP.IM:443/",
          },
        },
      } as RelayCoreConfig,
    });
    expect(account.baseUrl).toBe("https://api.relayapp.im");

    expect(() =>
      resolveRelayAccount({
        cfg: {
          channels: {
            relay: {
              token: "rly_test",
              baseUrl: "http://relay.example.test",
            },
          },
        } as RelayCoreConfig,
      }),
    ).toThrow(/must use HTTPS/u);

    expect(
      resolveRelayAccount({
        cfg: {
          channels: {
            relay: {
              token: "rly_test",
              baseUrl: "http://127.0.0.1:8790",
            },
          },
        } as RelayCoreConfig,
      }).baseUrl,
    ).toBe("http://127.0.0.1:8790");
  });

  it("normalizes and deduplicates Contact IDs and Handles", () => {
    const account = resolveRelayAccount({
      cfg: {
        channels: {
          relay: {
            token: "rly_test",
            allowFrom: [" alice ", "alice", "contact-id"],
          },
        },
      } as RelayCoreConfig,
    });
    expect(account.allowFrom).toEqual(["alice", "contact-id"]);
  });
});
