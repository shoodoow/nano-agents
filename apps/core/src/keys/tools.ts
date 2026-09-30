import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { open, seal } from "./keys.js";
import { toolKeys } from "../db/schema.js";

type Database = ReturnType<typeof getDb>;

/**
 * Reads a tool secret with account scope first, env fallback second.
 * Why: tenants bring their own Brave/Exa keys (isolated, sealed); self-host
 * operators set BRAVE_API_KEY/EXA_API_KEY once instead. Account scope wins
 * so one tenant's key never serves another.
 * Input: db, account id, tool name (brave|exa). Output: secret or null.
 */
export async function toolKeyFor(db: Database, accountId: string, tool: "brave" | "exa"): Promise<string | null> {
  const [row] = await db
    .select()
    .from(toolKeys)
    .where(and(eq(toolKeys.accountId, accountId), eq(toolKeys.tool, tool)));
  if (row) {
    const plain = open(row.secret).trim();
    if (plain) return plain;
  }
  const env = tool === "brave" ? process.env.BRAVE_API_KEY : process.env.EXA_API_KEY;
  return env?.trim() ? env.trim() : null;
}

/**
 * Saves one account-scoped tool secret (upsert, sealed).
 * Why: same AES envelope as provider keys, separate table so model enums
 * never leak tool credentials. Blank secret keeps a bad write from wiping.
 * Input: db, account id, tool, secret. Output: configured flag.
 */
export async function saveToolKey(db: Database, accountId: string, tool: "brave" | "exa", secret: string): Promise<{ configured: boolean }> {
  if (!secret.trim()) throw new Error("The secret is required.");
  const sealed = seal(secret.trim());
  const [existing] = await db
    .select({ tool: toolKeys.tool })
    .from(toolKeys)
    .where(and(eq(toolKeys.accountId, accountId), eq(toolKeys.tool, tool)));
  if (existing) {
    await db.update(toolKeys).set({ secret: sealed }).where(and(eq(toolKeys.accountId, accountId), eq(toolKeys.tool, tool)));
  } else {
    await db.insert(toolKeys).values({ accountId, tool, secret: sealed });
  }
  return { configured: true };
}
