import type { getDb } from "../db/client.js";
import { pluginToolOffers } from "../turn/plugins/registry.js";
import { mcpToolOffers } from "./tools.js";

type Db = ReturnType<typeof getDb>;

/** Plugin + account MCP tool lists for prompt prefix assembly. */
export async function toolPluginOffersForAccount(db: Db, accountId: string) {
  return [...pluginToolOffers(), ...(await mcpToolOffers(db, accountId))];
}
