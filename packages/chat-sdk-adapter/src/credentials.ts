import {
  AuthenticationError,
  ValidationError,
} from "@chat-adapter/shared";

export type RelayCredentialResolver = () =>
  | string
  | Promise<string>;

/**
 * Vendor-official credential shape required by Vercel Chat SDK.
 *
 * Resolver functions are intentionally invoked at the point of use, not at
 * construction, so Vercel Connect and other short-lived credential providers
 * can rotate values.
 */
export type RelayCredential = string | RelayCredentialResolver;

export function relayEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

export async function resolveRelayCredential(
  credential: RelayCredential | undefined,
  label: string,
): Promise<string> {
  let value: string | undefined;
  try {
    value =
      typeof credential === "function"
        ? await credential()
        : credential;
  } catch (error) {
    throw new AuthenticationError(
      "relay",
      `${label} resolver failed${
        error instanceof Error ? `: ${error.message}` : ""
      }`,
    );
  }
  if (!value?.trim()) {
    throw new AuthenticationError(
      "relay",
      `${label} is required and its resolver must return a non-empty string`,
    );
  }
  return value;
}

export function validateStaticCredential(
  credential: RelayCredential | undefined,
  label: string,
): void {
  if (typeof credential === "string" && !credential.trim()) {
    throw new ValidationError("relay", `${label} must not be empty`);
  }
}
