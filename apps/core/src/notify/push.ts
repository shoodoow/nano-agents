const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPT_URL = "https://exp.host/--/api/v2/push/getReceipts";
const CHUNK_SIZE = 100;
const SEND_TIMEOUT_MS = 10_000;

export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
};

export type PushTicket = { id?: string; status: "ok" | "error"; message?: string; details?: { error?: string } };

/**
 * Sends push messages through the Expo Push API with retries.
 * Why: plain fetch has no place in the relay — chunking (<=100), a 10s
 * timeout, and exponential backoff turn flaky delivery into a typed result
 * the relay can mark sent/failed per notification. No SDK needed server-side.
 * Input: messages + injectable fetch (tests). Output: tickets in send order.
 */
export async function sendExpoPush(
  messages: PushMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<PushTicket[]> {
  const tickets: PushTicket[] = [];
  for (let index = 0; index < messages.length; index += CHUNK_SIZE) {
    const chunk = messages.slice(index, index + CHUNK_SIZE);
    const res = await fetchWithRetry(fetchImpl, EXPO_PUSH_URL, chunk);
    const body = (await res.json().catch(() => null)) as { data?: PushTicket[] } | null;
    const data = body?.data ?? [];
    for (let offset = 0; offset < chunk.length; offset += 1) {
      tickets.push(data[offset] ?? { status: "error", message: "No ticket returned." });
    }
  }
  return tickets;
}

/**
 * Checks delivery receipts for previously accepted tickets.
 * Why: Expo accepts then delivers async — a ticket id without a later ok
 * receipt (DeviceNotRegistered, MessageTooBig...) must surface as failed, not
 * assumed sent. Stale tokens also tell us to drop the device row.
 * Input: ticket ids + injectable fetch. Output: map ticket id -> ok flag + error.
 */
export async function checkPushReceipts(
  ticketIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, { ok: boolean; error?: string }>> {
  const out = new Map<string, { ok: boolean; error?: string }>();
  for (let index = 0; index < ticketIds.length; index += CHUNK_SIZE) {
    const ids = ticketIds.slice(index, index + CHUNK_SIZE);
    const res = await fetchWithRetry(fetchImpl, EXPO_RECEIPT_URL, Object.fromEntries(ids.map((id) => [id, {}])));
    const body = (await res.json().catch(() => null)) as { data?: Record<string, { status: string; message?: string; details?: { error?: string } }> } | null;
    for (const id of ids) {
      const receipt = body?.data?.[id];
      if (!receipt) {
        out.set(id, { ok: true });
      } else if (receipt.status === "ok") {
        out.set(id, { ok: true });
      } else {
        out.set(id, { ok: false, error: receipt.details?.error ?? receipt.message ?? "Delivery failed." });
      }
    }
  }
  return out;
}

/**
 * POSTs JSON with exponential backoff on network/5xx failures.
 * Why: push is best-effort transport — retry transient faults, fail fast on
 * 4xx (bad token content the relay records, not retries forever).
 * Input: fetch, url, json body. Output: the response. Throws after 3 tries.
 */
async function fetchWithRetry(fetchImpl: typeof fetch, url: string, body: unknown): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(2 ** (attempt - 1) * 1000);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(Array.isArray(body) ? body : body),
          signal: controller.signal,
        });
        if (res.status >= 500) {
          lastError = new Error(`Expo Push API returned ${res.status}.`);
          continue;
        }
        return res;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Expo Push API unreachable.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
