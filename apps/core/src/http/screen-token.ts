import { createHmac, timingSafeEqual } from "node:crypto";

type ScreenTokenPayload = {
  accountId: string;
  profile: string;
  exp: number;
};

/**
 * Signs a short-lived token so the mobile WebView can open the screen socket
 * without planting HttpOnly session cookies (required on HTTPS).
 */
export function mintScreenToken(accountId: string, profile: string, secret: string, ttlSeconds = 120): string {
  const payload = Buffer.from(
    JSON.stringify({
      accountId,
      profile,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    } satisfies ScreenTokenPayload),
    "utf8",
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Validates a screen token and returns its payload when still valid. */
export function verifyScreenToken(token: string, secret: string): ScreenTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) {
    return null;
  }
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ScreenTokenPayload;
    if (typeof data.accountId !== "string" || typeof data.profile !== "string" || typeof data.exp !== "number") {
      return null;
    }
    if (data.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
