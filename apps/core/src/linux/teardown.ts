import { removeAccountContainers } from "./linux.js";

export default async function teardown(): Promise<void> {
  await removeAccountContainers();
}
