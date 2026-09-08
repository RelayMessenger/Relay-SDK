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
    name: "Node.js version",
    ok: nodeIsSupported(nodeVersion),
    detail: nodeVersion,
  });

  const permissions = await inspectConfigPermissions(dependencies.configContext);
  checks.push({
    name: "Relay config file",
    ok: permissions.secure,
    detail: permissions.exists
      ? permissions.aclChecked !== undefined
        ? permissions.aclChecked ? "only your Windows account can read it" : "Relay could not read the Windows permissions on it"
        : permissions.secure ? "only you can read it" : "other people on this computer can read it"
      : "no config file yet, which is fine when the token comes from RELAY_AGENT_TOKEN",
  });

  let auth: Awaited<ReturnType<typeof resolveAuth>> | undefined;
  try {
    auth = await resolveAuth(options.profile, dependencies.configContext);
    checks.push({
      name: "Token",
      ok: true,
      detail: auth.tokenSource === "environment" ? "taken from RELAY_AGENT_TOKEN" : `taken from the saved profile ${auth.profile}`,
    });
    checks.push({
      name: "Relay API address",
      ok: true,
      detail: validateApiURL(auth.apiURL),
    });
  } catch (error) {
    checks.push({
      name: "Token",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // `doctor` runs against whatever `@relaymessenger/sdk` is installed, so it
  // reports what that package carries and fails only when it is not Relay v1.
  // An exact count of calls cannot live here: it would be the published
  // package's number, which this workspace contradicts the moment the contract
  // grows. `scripts/validate-contract.mjs` holds the exact count, against the
  // workspace, where a change is meant to be reviewed.
  checks.push({
    name: "Installed Relay package",
    ok: RELAY_V1_OPERATIONS.length > 0
      && RELAY_V1_OPERATIONS.every((operation) =>
        operation.path.startsWith("/v1/")),
    detail: `it can make all ${RELAY_V1_OPERATIONS.length} Relay v1 calls`,
  });

  if (!options.offline && auth) {
    try {
      const client = dependencies.createClient(auth);
      await client.webhookEvents.list();
      checks.push({
        name: "Relay answers",
        ok: true,
        detail: "Relay answered this token",
      });
    } catch (error) {
      // Never print the raw error: it can carry headers, tokens or a socket
      // address the reader cannot act on.
      checks.push({
        name: "Relay answers",
        ok: false,
        detail: "Relay did not answer this token. Check your network, the API address above, and that the token is still valid.",
      });
    }
  } else if (options.offline) {
    checks.push({
      name: "Relay answers",
      ok: true,
      detail: "skipped, because you passed --offline",
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
};
