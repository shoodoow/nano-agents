import { describe, expect, it } from "vitest";
import { mintScreenToken, verifyScreenToken } from "./screen-token.js";

describe("screen token", () => {
  it("round-trips a valid token", () => {
    const token = mintScreenToken("acct-1", "uabc", "test-secret");
    const payload = verifyScreenToken(token, "test-secret");
    expect(payload).toEqual({ accountId: "acct-1", profile: "uabc", exp: expect.any(Number) });
  });

  it("rejects a tampered token", () => {
    const token = mintScreenToken("acct-1", "uabc", "test-secret");
    expect(verifyScreenToken(`${token}x`, "test-secret")).toBeNull();
    expect(verifyScreenToken(token, "wrong-secret")).toBeNull();
  });
});
