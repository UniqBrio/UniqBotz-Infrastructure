import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Integration tests — SYNTHETIC DATA, LOCAL DISPOSABLE DATABASE ONLY.
 * Requires the local Supabase Postgres image: `prototype/scripts/start-db.sh` (127.0.0.1:54329).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside a React Server Component bundle; the live service is exercised directly here.
      "server-only": fileURLToPath(new URL("./worker/test/integration/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["worker/test/integration/**/*.int.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
