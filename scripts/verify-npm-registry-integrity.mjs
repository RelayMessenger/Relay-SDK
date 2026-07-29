import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const propagation404 = /\bE404\b/iu;

function requirePositiveInteger(value, name) {
  const text = String(value);
  if (!/^[1-9]\d*$/u.test(text)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function queryRegistryIntegrity(packageSpec) {
  const result = spawnSync(
    npm,
    ["view", packageSpec, "dist.integrity", "--json"],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  if (result.status === 0) {
    let integrity;
    try {
      integrity = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(
        `npm view returned invalid JSON for ${packageSpec}:\n${result.stdout.trim()}`,
        { cause: error },
      );
    }
    return { integrity };
  }
  return {
    error: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
  };
}

export async function verifyNpmRegistryIntegrity({
  packageSpec,
  expectedIntegrity,
  maxAttempts = 24,
  retryDelayMs = 5_000,
  query = queryRegistryIntegrity,
  sleep = (delay) => new Promise((resolveWait) => setTimeout(resolveWait, delay)),
  log = (message) => process.stdout.write(`${message}\n`),
}) {
  if (!packageSpec) throw new Error("packageSpec is required");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(expectedIntegrity ?? "")) {
    throw new Error("expectedIntegrity must be an sha512 Subresource Integrity value");
  }
  requirePositiveInteger(String(maxAttempts), "maxAttempts");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("retryDelayMs must be a non-negative integer");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = query(packageSpec);
    if ("integrity" in result) {
      if (result.integrity !== expectedIntegrity) {
        throw new Error(
          `registry integrity ${result.integrity} != retained artifact ${expectedIntegrity}`,
        );
      }
      log(`registry integrity matches retained artifact: ${result.integrity}`);
      return result.integrity;
    }

    if (!propagation404.test(result.error)) {
      throw new Error(`npm view failed for ${packageSpec}:\n${result.error}`);
    }
    if (attempt === maxAttempts) {
      throw new Error(
        `npm registry did not expose ${packageSpec} after ${maxAttempts} attempts:\n${result.error}`,
      );
    }

    log(
      `npm registry has not exposed ${packageSpec} yet `
      + `(propagation attempt ${attempt}/${maxAttempts}); retrying`,
    );
    await sleep(retryDelayMs);
  }

  throw new Error("unreachable registry verification state");
}

async function main() {
  const [packageJsonPath, expectedIntegrity] = process.argv.slice(2);
  if (!packageJsonPath || !expectedIntegrity) {
    throw new Error(
      "usage: verify-npm-registry-integrity.mjs <package.json> <expected-integrity>",
    );
  }
  const packageJson = JSON.parse(
    readFileSync(resolve(process.cwd(), packageJsonPath), "utf8"),
  );
  const packageSpec = `${packageJson.name}@${packageJson.version}`;
  await verifyNpmRegistryIntegrity({
    packageSpec,
    expectedIntegrity,
    maxAttempts: requirePositiveInteger(
      process.env.NPM_REGISTRY_MAX_ATTEMPTS ?? "24",
      "NPM_REGISTRY_MAX_ATTEMPTS",
    ),
    retryDelayMs: requirePositiveInteger(
      process.env.NPM_REGISTRY_RETRY_DELAY_MS ?? "5000",
      "NPM_REGISTRY_RETRY_DELAY_MS",
    ),
  });
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
