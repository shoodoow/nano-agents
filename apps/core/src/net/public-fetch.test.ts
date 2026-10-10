import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { isPrivateAddress, isPrivateHost } from "./public-address.js";
import { publicFetch, publicLookup } from "./public-fetch.js";

describe("public address rules", () => {
  it("refuses loopback, private, link-local and mapped addresses in every spelling", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.4",
      "172.20.0.1",
      "192.168.1.9",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "[::1]",
      "[::]",
      "[::ffff:7f00:1]",
      "[::ffff:169.254.169.254]",
      "[fd00::1]",
      "[fe80::1]",
      "localhost",
      "api.localhost",
      "printer.local",
      "host.docker.internal",
      "metadata.google.internal.",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("allows public names and addresses", () => {
    for (const host of ["example.com", "8.8.8.8", "[2606:4700:4700::1111]", "172.32.0.1"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
    expect(isPrivateAddress("not-an-ip")).toBe(false);
  });
});

describe("publicFetch", () => {
  it("refuses a private address before connecting", async () => {
    const server = createServer((_req, res) => res.end("secret"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(publicFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/private or local/);
      await expect(publicFetch(`http://[::ffff:7f00:1]:${port}/`)).rejects.toThrow(/private or local/);
      await expect(publicFetch("file:///etc/passwd")).rejects.toThrow(/http and https/);
    } finally {
      server.close();
    }
  });

  it("refuses a name that resolves to a private address", async () => {
    const error = await new Promise<Error | null>((resolve) => {
      publicLookup("localhost", {}, (failure) => resolve(failure));
    });
    expect(error?.message).toMatch(/resolves to a private or local address/);
  });
});
