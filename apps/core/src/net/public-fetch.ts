import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { isPrivateAddress, isPrivateHost } from "./public-address.js";

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000;

type LookupCallback = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;

/**
 * Resolves a name and refuses the answer when any address is not public.
 * Why: checking the hostname text is not enough. A public name can point at
 * 127.0.0.1 or the cloud metadata address. This runs for the connection
 * itself, so the address that was checked is the address that is dialed, on
 * the first request and on every redirect.
 */
export function publicLookup(hostname: string, options: object, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const refused = addresses.find((entry) => isPrivateAddress(entry.address));
    if (refused || addresses.length === 0) {
      callback(new Error(`${hostname} resolves to a private or local address.`), []);
      return;
    }
    callback(null, addresses);
  });
}

export type PublicFetchLimits = { timeoutMs: number; maxBodyBytes: number };

/**
 * Builds a fetch for URLs a person or a remote server supplied, made from the core host.
 * Why: the core sits next to the database and the Docker socket, so a request
 * it makes on someone's behalf must only ever reach the public internet.
 * Input: how long one request may take and how large its body may be.
 * Output: a fetch whose response body is already read and capped. It throws
 * for a private target, a timeout, or a larger body.
 */
export function createPublicFetch(limits: PublicFetchLimits): typeof fetch {
  const { timeoutMs, maxBodyBytes } = limits;
  const dispatcher = new Agent({
    connect: { lookup: publicLookup as never, timeout: TIMEOUT_MS },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Only http and https addresses can be fetched.");
    }
    if (isPrivateHost(url.hostname)) {
      throw new Error("That address is private or local.");
    }
    const response = (await undiciFetch(url, {
      ...(init as object),
      dispatcher,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    })) as unknown as Response;
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBodyBytes) {
      throw new Error("The response is too large.");
    }
    const body = await readCapped(response, maxBodyBytes);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** The default: ten seconds and 1MB, for sign-in discovery and page fetches. */
export const publicFetch: typeof fetch = createPublicFetch({ timeoutMs: TIMEOUT_MS, maxBodyBytes: MAX_BODY_BYTES });

async function readCapped(response: Response, maxBodyBytes: number): Promise<ArrayBuffer | null> {
  if (!response.body || response.status === 204 || response.status === 304) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBodyBytes) {
      throw new Error("The response is too large.");
    }
    chunks.push(chunk);
  }
  const joined = Buffer.concat(chunks);
  return joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength) as ArrayBuffer;
}
