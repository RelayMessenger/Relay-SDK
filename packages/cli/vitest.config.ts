import { defineConfig } from "vitest/config";

// Native Windows credential workflows perform multiple independently bounded
// PowerShell ACL operations (15 seconds per subprocess). Apply a single finite
// suite-wide budget so top-level integration tests and hooks get the same room
// as describe-scoped cases. Leave POSIX Vitest defaults and all assertions intact.
export const nativeTimeouts = (platform: NodeJS.Platform) =>
  platform === "win32" ? { testTimeout: 120_000, hookTimeout: 120_000 } : {};

export default defineConfig({
  test: nativeTimeouts(process.platform),
});
