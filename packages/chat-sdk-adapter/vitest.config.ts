import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
    exclude: ["test/workerd/**"],
    include: ["test/**/*.test.ts"],
    setupFiles: ["@chat-adapter/tests/setup"],
  },
});
