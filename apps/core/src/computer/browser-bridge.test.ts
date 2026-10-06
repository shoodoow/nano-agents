import { describe, expect, it } from "vitest";
import { browserBridgeRequest } from "./browser-bridge.js";
import { accountContainerHostConfig, containerName } from "../linux/linux.js";

describe("browser bridge", () => {
  it("rejects unknown tools and non-http navigation", () => {
    expect(() => browserBridgeRequest("bash", {})).toThrow(/Unknown browser tool/);
    expect(() => browserBridgeRequest("browser_navigate", { url: "file:///etc/passwd" })).toThrow(/http/);
    const body = JSON.parse(browserBridgeRequest("browser_navigate", { url: "https://example.com/path" }));
    expect(body).toEqual({ tool: "browser_navigate", args: { url: "https://example.com/path" } });
  });

  it("keeps each account in its own container with no docker socket", () => {
    const account = "11111111-1111-4111-8111-111111111111";
    expect(containerName("alice@example.com")).toBe("nano-alice-at-example.com");
    const host = accountContainerHostConfig(account);
    expect(host.Binds).toEqual([`nano-account-${account}:/var/nano`]);
    expect(host.Privileged).toBe(false);
    expect(JSON.stringify(host.Binds)).not.toContain("docker.sock");
  });
});
