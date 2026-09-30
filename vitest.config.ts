import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Unit tests only (no database). Integration tests: vitest.integration.config.ts / `npm run test:integration`.
    include: ["src/**/*.test.ts", "worker/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.int.test.ts"],
  },
});
