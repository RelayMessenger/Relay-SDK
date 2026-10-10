import { defineConfig } from "vitest/config";

// Offline tests only: Workers AI, Vectorize and the Cloudflare REST API are mocks.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
