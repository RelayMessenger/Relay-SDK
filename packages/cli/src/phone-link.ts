import { defaultAuthURL, readConfig, type ConfigContext, type RelayConsoleOAuthSession } from "./config.js";
import { fetchSession, readOrganization, saveSession } from "./console-auth.js";
import { CliError } from "./error-codes.js";
import { HeadlessPrompt, type InteractivePrompts } from "./interactive.js";

/**
 * Links a phone to the signed-in Relay account, so the same account signs in
 * to the Relay app (owner, 2026-09-26: "You can link your phone number in the
 * console or via the CLI. Once linked, it is your own account for the Relay
 * app too."). Optional; no other command needs it.
 *
 * Relay-Auth texts and checks the code (branch phone-link-20260926):
 *   POST {auth}/api/auth/phone-link/send-otp {phoneNumber}
 *   POST {auth}/api/auth/phone-link/verify   {phoneNumber, code}
 *     → {status: "attached" | "merged", user: {id, phoneNumber, phoneNumberVerified}}
 * with the Console session this computer already holds as the bearer, the
 * way `relay login` reads the session (bearer plugin). "merged" means the
 * number already had a Relay app account and the two are now one, so the
 * saved session is read again and saved the way `relay login` saves it.
 */

/** Relay-Auth's own validator (src/auth.ts phoneNumberValidator). */
export const E164 = /^\+[1-9]\d{7,14}$/u;
/** Relay-Auth's codes are six digits (Telnyx Verify). */
export const OTP = /^\d{6}$/u;

const INVALID_NUMBER = "Enter your phone number with its country code, for example +15551234567.";
const INVALID_CODE = "The code is the six digits in the text message.";

/**
 * Relay-Auth's refusals, as the Console words them (Relay-Console branch
 * verify-phone-20260926, routes/phone.ts): Better Auth's phoneNumber plugin
 * names its OTP refusals INVALID_OTP, OTP_EXPIRED, OTP_NOT_FOUND and
 * TOO_MANY_ATTEMPTS, and the phone-link endpoints reuse them.
 */
const REFUSALS: Record<string, string> = {
  INVALID_OTP: "That code is not right. Check it and try again.",
  OTP_EXPIRED: "That code has expired. Send a new code.",
  OTP_NOT_FOUND: "That code has expired. Send a new code.",
  TOO_MANY_ATTEMPTS: "That code was wrong too many times. Send a new code.",
  INVALID_PHONE_NUMBER: INVALID_NUMBER,
  // Relay-Auth's own sentences (src/phone-link.ts PHONE_LINK_ERROR_CODES).
  PHONE_NUMBER_ALREADY_SET: "This account already has a different phone number. Nothing was changed.",
  PHONE_NUMBER_IN_USE: "This phone number belongs to another console account. Nothing was changed.",
  BOTH_HAVE_APP_PROFILES: "Both accounts have a Relay app profile. Nothing was changed.",
};

export class PhoneLinkRefusal extends CliError {
  constructor(message: string, readonly authCode: string | undefined) { super(message, "refused"); }
}

export interface PhoneLinkDependencies {
  context: ConfigContext;
  apiURL?: string;
  fetch?: typeof globalThis.fetch;
  /** Present only when a person is at a terminal and may be asked. */
  prompts?: InteractivePrompts;
  stderr: (value: string) => void;
}

export interface PhoneLinkResult {
  ok: true;
  status: "code_sent" | "attached" | "merged";
  phone_number: string;
  user?: { id: string };
  /** "refreshed" after a merge: this computer's Console sign-in was read again and saved. */
  session?: "refreshed" | "unchanged";
}

const signedInPerson = async (context: ConfigContext): Promise<RelayConsoleOAuthSession> => {
  const session = (await readConfig(context)).console;
  if (!session) throw new CliError("Relay Console is not signed in. Run relay login first.", "no_token");
  if (session.type === "organization_key") {
    throw new CliError("An organization API key has no phone. Run relay login to sign in as yourself.", "refused");
  }
  if (session.expires_at <= Date.now()) throw new CliError("Your Relay Console sign-in expired.", "signin_expired");
  return session;
};

const post = async (
  deps: PhoneLinkDependencies,
  session: RelayConsoleOAuthSession,
  path: "send-otp" | "verify",
  body: Record<string, string>,
): Promise<Response> => {
  const auth = defaultAuthURL(deps.context.env ?? process.env);
  return (deps.fetch ?? globalThis.fetch)(`${auth}/api/auth/phone-link/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
};

/** Relay-Auth's refusal as one sentence; nothing from its body but its short code travels. */
const refusal = async (response: Response): Promise<Error> => {
  if (response.status === 401) return new CliError("Your Relay Console sign-in expired.", "signin_expired");
  if (response.status === 404) return new CliError("This Relay does not offer phone linking yet. Nothing was changed.", "refused");
  if (response.status === 429) return new CliError("Too many codes were sent. Wait a moment and try again.", "refused");
  const value = await response.json().catch(() => null) as { code?: unknown } | null;
  const code = typeof value?.code === "string" && /^[A-Z_]{1,40}$/u.test(value.code) ? value.code : undefined;
  return new PhoneLinkRefusal(
    (code && REFUSALS[code]) ?? `Relay could not link your phone (HTTP ${response.status}). Nothing was changed.`,
    code,
  );
};

/** Relay-Auth's answer to a correct code. */
const linked = async (response: Response): Promise<{ status: "attached" | "merged"; user: { id: string } }> => {
  const value = await response.json().catch(() => null) as { status?: unknown; user?: { id?: unknown } } | null;
  if ((value?.status !== "attached" && value?.status !== "merged") || typeof value.user?.id !== "string") {
    throw new CliError("Relay did not say whether your phone was linked. Check it in Relay Console.", "refused");
  }
  return { status: value.status, user: { id: value.user.id } };
};

/**
 * After a merge the account this computer signed in with was folded into the
 * phone app account. Relay-Auth moves the session with the merge, so the same
 * bearer now names the merged user (Relay-Auth src/phone-link.ts); a
 * `set-auth-token` header, the bearer plugin's way of handing out a new
 * session, wins when present. The session is then read and saved exactly as
 * `relay login` does (get-session, then the Console's /me).
 */
const refreshSession = async (
  deps: PhoneLinkDependencies,
  previous: RelayConsoleOAuthSession,
  response: Response,
): Promise<void> => {
  const token = response.headers.get("set-auth-token")?.trim() || previous.access_token;
  const authDeps = { context: deps.context, ...(deps.apiURL ? { apiURL: deps.apiURL } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  try {
    const signedIn = await fetchSession(authDeps, token);
    const organizationId = await readOrganization(authDeps, signedIn);
    await saveSession(deps.context, {
      access_token: signedIn.access_token,
      expires_at: signedIn.expires_at,
      organization_id: organizationId,
      user: signedIn.user,
    });
  } catch {
    throw new CliError("Your phone is linked, but this computer's sign-in could not be refreshed. Run relay login.", "signin_expired");
  }
};

const askNumber = async (prompts: InteractivePrompts): Promise<string> =>
  (await prompts.text("Your phone number, with its country code", "", {
    placeholder: "+15551234567",
    validate: (value) => E164.test(value.trim()) ? undefined : INVALID_NUMBER,
  })).trim();

const askCode = async (prompts: InteractivePrompts): Promise<string> =>
  (await prompts.text("The six-digit code in the text message", "", {
    validate: (value) => OTP.test(value.trim()) ? undefined : INVALID_CODE,
  })).trim();

export async function linkPhone(
  options: { number?: string; code?: string },
  deps: PhoneLinkDependencies,
): Promise<PhoneLinkResult> {
  const session = await signedInPerson(deps.context);
  let phoneNumber = options.number?.trim();
  if (phoneNumber === undefined) {
    if (!deps.prompts) {
      throw new HeadlessPrompt("Relay needs your phone number to text you a code.", [
        "--number <+15551234567>  to text the code",
        "--number <+15551234567> --code <123456>  to link the phone with that code",
      ]);
    }
    phoneNumber = await askNumber(deps.prompts);
  }
  if (!E164.test(phoneNumber)) throw new CliError(INVALID_NUMBER, "usage");
  let code = options.code?.trim();
  if (code !== undefined && !OTP.test(code)) throw new CliError(INVALID_CODE, "usage");

  if (code === undefined) {
    const sent = await post(deps, session, "send-otp", { phoneNumber });
    if (!sent.ok) throw await refusal(sent);
    if (!deps.prompts) {
      // No one to ask: the code arrives by text, so the second step is its own run.
      deps.stderr(`Relay texted a code to ${phoneNumber}. Run  relay phone link --number ${phoneNumber} --code <code>  to finish.\n`);
      return { ok: true, status: "code_sent", phone_number: phoneNumber };
    }
    deps.prompts.step(`Relay texted a code to ${phoneNumber}.`);
    code = await askCode(deps.prompts);
  }

  for (;;) {
    const response = await post(deps, session, "verify", { phoneNumber, code });
    if (response.ok) {
      const result = await linked(response);
      if (result.status === "merged") await refreshSession(deps, session, response);
      return {
        ok: true,
        status: result.status,
        phone_number: phoneNumber,
        user: result.user,
        session: result.status === "merged" ? "refreshed" : "unchanged",
      };
    }
    const failure = await refusal(response);
    // A person at a terminal gets another try at a mistyped code, as the Console's field does.
    if (!deps.prompts || !(failure instanceof PhoneLinkRefusal) || failure.authCode !== "INVALID_OTP") throw failure;
    deps.prompts.message(failure.message);
    code = await askCode(deps.prompts);
  }
}

/** The sentence a person reads after a link. */
export const phoneLinkSentence = (result: PhoneLinkResult): string | undefined =>
  result.status === "attached"
    ? `Your phone ${result.phone_number} is linked. Sign in to the Relay app with it to use this same account.`
    : result.status === "merged"
      ? `Your phone ${result.phone_number} already had a Relay app account. It is now one account with this one, and this computer's sign-in was refreshed.`
      : undefined;
