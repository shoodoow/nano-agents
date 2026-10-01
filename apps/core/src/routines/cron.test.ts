import { describe, expect, it } from "vitest";
import { nextCronRun } from "./cron.js";

describe("nextCronRun", () => {
  it("fires daily at 09:00 wall time, including across a DST offset", () => {
    const winter = Date.parse("2026-01-15T07:00:00.000Z");
    expect(nextCronRun("0 9 * * *", "Europe/Berlin", winter).toISOString()).toBe("2026-01-15T08:00:00.000Z");
    const summer = Date.parse("2026-07-15T06:00:00.000Z");
    expect(nextCronRun("0 9 * * *", "Europe/Berlin", summer).toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });

  it("fires weekly on the named weekday", () => {
    const thursday = Date.parse("2026-01-15T12:00:00.000Z");
    expect(nextCronRun("30 9 * * 1", "UTC", thursday).toISOString()).toBe("2026-01-19T09:30:00.000Z");
  });

  it("fires on weekday ranges and lists", () => {
    // Thursday 2026-01-15 12:00 UTC; next weekday 9:32 is Friday.
    const thursday = Date.parse("2026-01-15T12:00:00.000Z");
    expect(nextCronRun("32 9 * * 1-5", "UTC", thursday).toISOString()).toBe("2026-01-16T09:32:00.000Z");
    // Saturday 2026-01-17 12:00 UTC; next weekday 9:32 is Monday.
    const saturday = Date.parse("2026-01-17T12:00:00.000Z");
    expect(nextCronRun("32 9 * * 1-5", "UTC", saturday).toISOString()).toBe("2026-01-19T09:32:00.000Z");
    // Sunday 2026-01-18 12:00 UTC; Mon/Wed/Fri list lands on Monday.
    const sunday = Date.parse("2026-01-18T12:00:00.000Z");
    expect(nextCronRun("0 9 * * 1,3,5", "UTC", sunday).toISOString()).toBe("2026-01-19T09:00:00.000Z");
    expect(() => nextCronRun("0 9 * * 5-1", "UTC", thursday)).toThrow(/forward/);
    expect(() => nextCronRun("0 9 * * 8", "UTC", thursday)).toThrow(/0-7/);
  });

  it("steps */N from now and rejects bad shapes and timezones", () => {
    const from = 1_700_000_000_000;
    expect(nextCronRun("*/15 * * * *", "UTC", from).getTime()).toBe(from + 15 * 60_000);
    expect(() => nextCronRun("0 9 * * *", "Not/AZone")).toThrow(/Unknown timezone/);
    expect(() => nextCronRun("0 9 1 * *", "UTC")).toThrow(/Unsupported/);
    expect(() => nextCronRun("99 9 * * *", "UTC")).toThrow(/minute/);
  });
});
