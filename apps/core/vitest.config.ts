import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./src/db/test-database.js";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    exclude: ["dist/**", "node_modules/**"],
    // Tests get their own database and a fixed secret, never the developer's.
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      BETTER_AUTH_SECRET: "test-only-secret-not-used-outside-vitest-runs",
    },
    // globalSetup returning the teardown: the standalone globalTeardown file
    // never fired under vitest (proven by marker test), leaking one container
    // per test account. This pattern is verified to run.
    globalSetup: "./src/linux/test-setup.ts",
  },
});
