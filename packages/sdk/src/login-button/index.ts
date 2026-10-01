import { createElement, type ButtonHTMLAttributes, type ReactElement } from "react";

/**
 * Relay's "Connect Relay" button for React, the twin of the hosted script
 * (https://auth.relayapp.im/js/relay-login.js). Both are Relay's own shape,
 * Telegram's "Connect Telegram" pill in Relay blue. A click starts a
 * standard OpenID Connect authorization code flow with PKCE (RFC 7636) and
 * a nonce, and keeps `state`, `nonce` and `code_verifier` for ten minutes in
 * a first-party cookie named `relay_login` (base64url JSON). Your callback
 * reads that cookie and exchanges the code with any OpenID Connect library,
 * with your client secret, checking the state and the nonce.
 */

/** Relay's authorization server. Staging is `https://auth.staging.relayapp.im`. */
export const RELAY_AUTH_ORIGIN = "https://auth.relayapp.im";

export interface RelayLoginOptions {
  /** Your client ID: your agent's ID. */
  clientId: string;
  /** One of the redirects in your agent's OAuth2 settings. */
  redirectUri: string;
  /** Defaults to "openid profile". Add "email", "phone" or "birthdate" when your agent's scopes allow them. */
  scope?: string;
  /** Defaults to {@link RELAY_AUTH_ORIGIN}. */
  authOrigin?: string;
}

const BLUE = "#0B75FF";

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const random = (size: number): string => base64url(crypto.getRandomValues(new Uint8Array(size)));

/** Starts the login: saves the cookie and opens Relay. */
export async function startRelayLogin(options: RelayLoginOptions): Promise<void> {
  const state = random(24);
  const nonce = random(24);
  const verifier = random(32);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const saved = base64url(new TextEncoder().encode(JSON.stringify({ state, nonce, code_verifier: verifier })));
  document.cookie = `relay_login=${saved}; Path=/; Max-Age=600; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: options.scope ?? "openid profile",
    state,
    nonce,
    code_challenge: base64url(digest),
    code_challenge_method: "S256",
  });
  location.assign(`${options.authOrigin ?? RELAY_AUTH_ORIGIN}/api/auth/oauth2/authorize?${query.toString()}`);
}

const mark = createElement(
  "svg",
  { viewBox: "0 0 1024 1024", width: 22, height: 22, "aria-hidden": true, style: { flex: "none" } },
  createElement("path", {
    d: "M512 185C701 185 854 314 854 475C854 656 695 827 523 827C493 827 467 824 446 815C369 861 302 883 284 865C268 848 300 773 317 720C246 665 210 582 210 484C210 319 344 185 512 185Z",
    fill: "#fff",
  }),
  createElement("path", {
    d: "M372 514C372 470 408 434 452 434C496 434 532 470 532 514M600 514C600 470 636 434 680 434C724 434 760 470 760 514",
    fill: "none", stroke: BLUE, strokeWidth: 48, strokeLinecap: "round",
  }),
);

export type RelayLoginButtonProps = RelayLoginOptions & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">;

/** `<RelayLoginButton clientId="…" redirectUri="…" />`: the "Connect Relay" pill. */
export function RelayLoginButton({ clientId, redirectUri, scope, authOrigin, children, style, ...rest }: RelayLoginButtonProps): ReactElement {
  return createElement(
    "button",
    {
      type: "button",
      ...rest,
      onClick: () => void startRelayLogin({ clientId, redirectUri, ...(scope ? { scope } : {}), ...(authOrigin ? { authOrigin } : {}) }),
      style: {
        display: "inline-flex", alignItems: "center", gap: 8, height: 40, padding: "0 18px 0 14px",
        border: 0, borderRadius: 20, background: BLUE, color: "#fff", cursor: "pointer",
        font: "600 15px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        ...style,
      },
    },
    mark,
    createElement("span", null, children ?? "Connect Relay"),
  );
}
