import { defineConfig } from "vitest/config";

// Native Windows credential workflows perform multiple independently bounded
// PowerShell ACL operations (15 seconds per subprocess). Apply a single finite
// suite-wide budget so top-level integration tests and hooks get the same room
// as describe-scoped cases. Leave POSIX Vitest defaults and all assertions intact.
export const nativeTimeouts = (platform: NodeJS.Platform) =>
  platform === "win32" ? { testTimeout: 120_000, hookTimeout: 120_000 } : {};

export default defineConfig({
  test: {
    ...nativeTimeouts(process.platform),
    // Output assertions read plain text. picocolors (and clack) colour whenever
    // `CI` is set, so GitHub runs got escape codes the assertions never expect.
    // NO_COLOR wins over CI and FORCE_COLOR in both libraries (no-color.org).
    env: { NO_COLOR: "1" },
  },
});
