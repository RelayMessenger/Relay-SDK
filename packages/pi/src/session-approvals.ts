import { denialMessage, type ApprovalChoice, type OwnerApprovals } from "./approvals.js";

/**
 * The owner's approval card for the Pi session Relay runs in, through
 * `@gotgenes/pi-permission-system`.
 *
 * In RPC mode that extension asks with `ctx.ui.select`, which Pi sends to
 * the app driving the session as an `extension_ui_request` (pi-permission-
 * system src/authority/permission-dialog.ts, `requestPermissionDecisionFromUi`;
 * Pi docs/rpc.md, "Extension UI Protocol"). Another extension in the same
 * process cannot answer that dialog. What it offers instead is a live-
 * authority chain link: a sibling extension registers one with
 * `registerAuthorizer`, and the link answers `allow`, `deny` or `defer` before
 * the dialog opens (docs/cross-extension-api.md, "Ready Event";
 * docs/configuration.md, "Authorizer chain"). The operator turns it on by
 * naming it in `authorizerChain`.
 *
 * This link sends the same card the Relay CLI sends in channel mode when the
 * run asking was started by a Relay Message, and defers otherwise, so a run
 * typed at the app is asked in the app as before.
 */

/** The name to list in pi-permission-system's `authorizerChain`. */
export const RELAY_AUTHORIZER = "relay";

/** The parts of pi-permission-system's `PromptPermissionDetails` the card reads (dist/public.d.ts). */
export interface PermissionAsk {
  readonly payload: {
    readonly request: { readonly surface: string; readonly toolName: string | null; readonly value: string };
  };
  readonly sessionApproval?: { readonly grants: readonly { readonly surface: string; readonly pattern: string }[] };
  readonly accessIntent?: { readonly surface: string };
}

/** pi-permission-system's `AuthorizerVerdict`. */
export type PermissionVerdict = { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" };

export const RELAY_APPROVAL_CHOICES: readonly ApprovalChoice[] = [
  { id: "allow_once", label: "Allow once", decision: "allow_once" },
  { id: "allow_session", label: "Allow for session", decision: "allow_session" },
  { id: "deny", label: "Deny", decision: "deny" },
];

/**
 * The surfaces whose `allow` the chain caps to `defer` ("bounded-delegation
 * checkpoint", docs/configuration.md): `path` and `external_directory` with
 * their directional members. An owner asked about one could not approve it.
 */
const capped = (surface: string): boolean => /^(path|external_directory)(_|$)/u.test(surface);

/**
 * The grant an "Allow for session" stands for: the session patterns
 * pi-permission-system suggests for the ask, else the exact surface and
 * value. A later ask is allowed without a card only when it carries the same
 * key, so the link never allows more than the owner saw.
 */
const grantKey = (ask: PermissionAsk): string => {
  const grants = ask.sessionApproval?.grants;
  if (grants?.length) return JSON.stringify(grants.map((grant) => [grant.surface, grant.pattern]).sort());
  return JSON.stringify([ask.payload.request.surface, ask.payload.request.value]);
};

export interface RelayAuthorizerOptions {
  readonly approvals: Pick<OwnerApprovals, "ask">;
  /** Whether the run asking now was started by a Relay Message. */
  readonly fromRelay: () => boolean;
  /** How long the owner has to answer; `APPROVAL_TIMEOUT_MS` (10 minutes) when absent. */
  readonly timeoutMs?: number;
}

/**
 * The link's `authorize`. An answered card allows or denies; a card nobody
 * answers in time denies; a card that could not be sent defers to the app.
 */
export const relayAuthorizer = (options: RelayAuthorizerOptions): {
  authorize(ask: PermissionAsk): Promise<PermissionVerdict>;
  /** Forgets this session's grants, at `session_shutdown`. */
  reset(): void;
} => {
  const granted = new Set<string>();
  return {
    reset: () => { granted.clear(); },
    authorize: async (ask) => {
      if (!options.fromRelay() || capped(ask.accessIntent?.surface ?? ask.payload.request.surface)) return { kind: "defer" };
      const key = grantKey(ask);
      if (granted.has(key)) return { kind: "allow" };
      const { surface, toolName, value } = ask.payload.request;
      const tool = toolName ?? surface;
      const patterns = ask.sessionApproval?.grants.map((grant) => grant.pattern).join(", ");
      const outcome = await options.approvals.ask({
        harness: "Pi",
        tool,
        title: `Pi asks to use ${tool}.`,
        summary: value,
        ...(patterns ? { note: `Allow for session covers ${patterns}` } : {}),
        detail: value,
        extra: false,
        choices: RELAY_APPROVAL_CHOICES,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      switch (outcome.choice?.decision) {
        case "allow_session": granted.add(key); return { kind: "allow" };
        case "allow_once": return { kind: "allow" };
        case "deny": return { kind: "deny", reason: denialMessage(outcome) };
        default: break;
      }
      // Nobody answered in time: not approved. No owner could be asked: the app asks.
      return outcome.reason === "timeout" ? { kind: "deny", reason: denialMessage(outcome) } : { kind: "defer" };
    },
  };
};

/** pi-permission-system's per-session services (src/service.ts, `SESSION_SERVICES_KEY`; docs/cross-extension-api.md, "How It Works"). */
const SERVICES = Symbol.for("@gotgenes/pi-permission-system:session-services");

interface PermissionsService {
  registerAuthorizer(name: string, authorize: (ask: PermissionAsk) => Promise<PermissionVerdict>): () => void;
}

/**
 * Registers the link with the session's pi-permission-system, read from the
 * process-global map its docs name, so Relay needs no dependency on it. Does
 * nothing when it is not loaded. Returns the disposer.
 */
export const registerRelayAuthorizer = (sessionId: string, authorize: (ask: PermissionAsk) => Promise<PermissionVerdict>): (() => void) | undefined => {
  const services = (globalThis as Record<symbol, unknown>)[SERVICES] as Map<string, PermissionsService> | undefined;
  return services?.get(sessionId)?.registerAuthorizer(RELAY_AUTHORIZER, authorize);
};
