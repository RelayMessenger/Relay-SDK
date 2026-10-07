import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
      "cloudflare:email": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    server: { deps: { inline: [/@cloudflare\/think/, /node_modules\/agents\//] } },
  },
});
