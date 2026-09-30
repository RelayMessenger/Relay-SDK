import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayLoginButton, startRelayLogin } from "../src/login-button/index.js";

describe("the Connect Relay button", () => {
  afterEach(() => vi.unstubAllGlobals());

  const browser = () => {
    const cookies: string[] = [];
    const assign = vi.fn();
    vi.stubGlobal("document", { set cookie(value: string) { cookies.push(value); } });
    vi.stubGlobal("location", { protocol: "https:", assign });
    return { cookies, assign };
  };

  it("opens Relay's authorize endpoint with PKCE, state and nonce, and keeps them in the relay_login cookie", async () => {
    const { cookies, assign } = browser();
    await startRelayLogin({ clientId: "agent-id", redirectUri: "https://youlearn.ai/cb", scope: "openid profile email", authOrigin: "https://auth.staging.relayapp.im" });
    const url = new URL(assign.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe("https://auth.staging.relayapp.im/api/auth/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code", client_id: "agent-id", redirect_uri: "https://youlearn.ai/cb", scope: "openid profile email", code_challenge_method: "S256",
    });
    const cookie = cookies[0]!;
    expect(cookie).toMatch(/^relay_login=[^;]+; Path=\/; Max-Age=600; SameSite=Lax; Secure$/);
    const saved = JSON.parse(Buffer.from(cookie.slice("relay_login=".length).split(";")[0]!, "base64url").toString()) as Record<string, string>;
    expect(saved.state).toBe(url.searchParams.get("state"));
    expect(saved.nonce).toBe(url.searchParams.get("nonce"));
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(saved.code_verifier))).toString("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
  });

  it("is a button that starts the login on click", async () => {
    const { assign } = browser();
    const element = RelayLoginButton({ clientId: "agent-id", redirectUri: "https://youlearn.ai/cb" });
    expect(element.type).toBe("button");
    (element.props as { onClick: () => void }).onClick();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(new URL(assign.mock.calls[0]![0] as string).origin).toBe("https://auth.relayapp.im");
  });
});
