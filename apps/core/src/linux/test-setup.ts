import { prepareTestDatabase } from "../db/test-database.js";
import { removeAccountContainers } from "./linux.js";

/**
 * Global test setup: prepares the test database and returns the scoped teardown.
 * Why: vitest never executed the previous globalTeardown file (verified: a
 * marker write inside it never appeared), so every test run leaked one Docker
 * container per test account. The setup-returning-teardown pattern is the
 * documented, working equivalent. Cleanup is scoped to nano.test=1 containers
 * so a test run can never delete the developer's real account computer.
 * Input: none. Output: the teardown that wipes only test computers.
 */
export default async function setup(): Promise<() => Promise<void>> {
  await prepareTestDatabase();
  return async () => {
    await removeAccountContainers({ testOnly: true });
  };
}
