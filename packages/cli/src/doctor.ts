import { RELAY_V1_OPERATIONS } from "@relaymessenger/sdk";
import type Relay from "@relaymessenger/sdk";
import type { ConfigContext } from "./config.js";
import {
  inspectConfigPermissions,
  resolveAuth,
  validateApiURL,
} from "./config.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const nodeIsSupported = (version: string): boolean => {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, "")
    .split(".")
    .map(Number);
  return major > 22
    || (major === 22 && (minor > 22 || (minor === 22 && patch >= 3)));
};

export const runDoctor = async (
  options: {
    profile?: string;
    offline?: boolean;
    nodeVersion?: string;
  },
  dependencies: {
    configContext?: ConfigContext;
    createClient(auth: Awaited<ReturnType<typeof resolveAuth>>): Relay;
  },
): Promise<DoctorReport> => {
  const checks: DoctorCheck[] = [];
  const nodeVersion = options.nodeVersion ?? process.version;
  checks.push({
    name: "node",
    ok: nodeIsSupported(nodeVersion),
    detail: nodeVersion,
  });

  const permissions = await inspectConfigPermissions(dependencies.configContext);
  checks.push({
    name: "config_permissions",
    ok: permissions.secure,
    detail: permissions.exists
      ? `mode ${(permissions.mode ?? 0).toString(8).padStart(3, "0")}`
      : "no local config (environment-only is allowed)",
  });

  let auth: Awaited<ReturnType<typeof resolveAuth>> | undefined;
  try {
    auth = await resolveAuth(options.profile, dependencies.configContext);
    checks.push({
      name: "agent_token",
      ok: true,
      detail: `resolved from ${auth.tokenSource}`,
    });
    checks.push({
      name: "api_url",
      ok: true,
      detail: validateApiURL(auth.apiURL),
    });
  } catch (error) {
    checks.push({
      name: "agent_token",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // `doctor` runs against whatever `@relaymessenger/sdk` the user installed,
  // so it reports what that SDK carries and fails only when the contract is
  // not Relay v1. An exact operation count cannot live here: it would have to
  // be the published SDK's number, which the workspace SDK contradicts the
  // moment the contract grows. `scripts/check-contract.mjs` holds the exact
  // count, against the workspace, where a change is meant to be reviewed.
  checks.push({
    name: "sdk_contract",
    ok: RELAY_V1_OPERATIONS.length > 0
      && RELAY_V1_OPERATIONS.every((operation) =>
        operation.path.startsWith("/v1/")),
    detail: `${RELAY_V1_OPERATIONS.length} v1 operations`,
  });

  if (!options.offline && auth) {
    try {
      const client = dependencies.createClient(auth);
      await client.webhookEvents.list();
      checks.push({
        name: "api_reachability",
        ok: true,
        detail: "read-only webhook event list succeeded",
      });
    } catch (error) {
      checks.push({
        name: "api_reachability",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (options.offline) {
    checks.push({
      name: "api_reachability",
      ok: true,
      detail: "skipped (--offline)",
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
};
