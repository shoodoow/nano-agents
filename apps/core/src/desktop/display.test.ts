import { describe, expect, it } from "vitest";
import { agentDisplay, cdpPortFor, clampPoint, displayFor, displayName, novncPort, portsFor } from "./desktop.js";

/**
 * Locks the single-source-of-truth display contract: agent tools, bash
 * DISPLAY, screenshots, and the noVNC viewer all derive the same :N and ports
 * purely from the username, so restarts can never desync viewer vs agent.
 */
describe("deterministic display", () => {
  it("derives a stable display in range 10-79", () => {
    expect(displayFor("uabc123")).toBe(displayFor("uabc123"));
    expect(displayFor("uabc123")).toBeGreaterThanOrEqual(10);
    expect(displayFor("uabc123")).toBeLessThanOrEqual(79);
    expect(displayFor("uother")).not.toBe(displayFor("uabc123"));
  });

  it("resolves identical display and ports for agent and viewer", () => {
    const profile = "uabc123def45678";
    expect(agentDisplay("acct-1", profile)).toBe(displayName(profile));
    expect(novncPort("acct-1", profile)).toBe(portsFor(profile).novncPort);
    expect(novncPort("acct-1", profile)).toBe(6900 + displayFor(profile));
    expect(cdpPortFor(profile)).toBe(9200 + displayFor(profile));
  });

  it("gives each profile its own CDP port on a shared container", () => {
    const ana = "uc0bf3479a7ba471c";
    const melanie = "ua8488019b9ff4510";
    expect(cdpPortFor(ana)).not.toBe(cdpPortFor(melanie));
    expect(cdpPortFor(ana)).toBe(9200 + displayFor(ana));
  });

  it("clamps grounding coordinates to 1280x800", () => {
    expect(clampPoint(200, 80)).toEqual({ x: 200, y: 80 });
    expect(clampPoint(-5, 9999)).toEqual({ x: 0, y: 799 });
    expect(clampPoint(1279.6, 100)).toEqual({ x: 1279, y: 100 });
    expect(clampPoint(NaN, 10)).toEqual({ x: 0, y: 10 });
  });
});
