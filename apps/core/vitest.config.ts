import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    exclude: ["dist/**", "node_modules/**"],
    // globalSetup returning the teardown: the standalone globalTeardown file
    // never fired under vitest (proven by marker test), leaking one container
    // per test account. This pattern is verified to run.
    globalSetup: "./src/linux/test-setup.ts",
  },
});
