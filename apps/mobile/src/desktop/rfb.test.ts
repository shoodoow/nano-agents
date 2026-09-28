import { describe, expect, it } from "vitest";
import { mapPointer, RfbReader } from "./rfb.js";

describe("rfb", () => {
  it("paints a raw framebuffer update into a PNG", () => {
    const reader = new RfbReader();
    const sent: Uint8Array[] = [];
    const frames: string[] = [];
    const feed = (chunk: Uint8Array) => {
      for (const event of reader.push(chunk)) {
        if (event.type === "send") {
          sent.push(event.data);
        }
        if (event.type === "frame") {
          frames.push(event.uri);
        }
        if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    };

    feed(text("RFB 003.008\n"));
    expect(ascii(sent[0] ?? new Uint8Array())).toBe("RFB 003.008\n");
    feed(new Uint8Array([1, 1]));
    expect([...(sent[1] ?? [])]).toEqual([1]);
    feed(new Uint8Array([0, 0, 0, 0]));
    expect([...(sent[2] ?? [])]).toEqual([1]);

    const init = new Uint8Array(24);
    init[1] = 2;
    init[3] = 1;
    feed(init);
    expect(sent[3]?.[0]).toBe(0);
    expect(sent[3]?.[20]).toBe(2);
    expect(sent[3]?.[28]).toBe(3);

    const update = new Uint8Array(4 + 12 + 8);
    update[3] = 1;
    update[9] = 2;
    update[11] = 1;
    update[18] = 255;
    update[21] = 255;
    feed(update);

    expect(frames).toHaveLength(1);
    expect([...reader.rgba]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect([...decodePng(frames[0] ?? "")]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(sent.at(-1)?.[0]).toBe(3);
    expect(sent.at(-1)?.[1]).toBe(1);
  });

  it("sends a key and skips the cursor picture", () => {
    const reader = new RfbReader();
    expect([...reader.key(0x61, true)]).toEqual([4, 1, 0, 0, 0, 0, 0, 0x61]);
    const sent: Uint8Array[] = [];
    const frames: string[] = [];
    const feed = (chunk: Uint8Array) => {
      for (const event of reader.push(chunk)) {
        if (event.type === "send") {
          sent.push(event.data);
        }
        if (event.type === "frame") {
          frames.push(event.uri);
        }
        if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    };
    feed(text("RFB 003.008\n"));
    feed(new Uint8Array([1, 1]));
    feed(new Uint8Array([0, 0, 0, 0]));
    const init = new Uint8Array(24);
    init[1] = 1;
    init[3] = 1;
    feed(init);
    const update = new Uint8Array(4 + 12 + 4 + 1);
    update[3] = 1;
    update[9] = 1;
    update[11] = 1;
    const view = new DataView(update.buffer);
    view.setInt32(12, -239);
    update[18] = 255;
    update[19] = 0;
    update[20] = 0;
    feed(update);
    expect(frames).toHaveLength(1);
    expect([...reader.rgba]).toEqual([0, 0, 0, 0]);
  });

  it("maps a touch inside the fitted picture and ignores the margin", () => {
    expect(mapPointer(10, 10, { width: 100, height: 100 }, { width: 2, height: 1 })).toBeNull();
    expect(mapPointer(50, 50, { width: 100, height: 100 }, { width: 2, height: 1 })).toEqual({ x: 1, y: 0 });
  });
});

function text(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function ascii(data: Uint8Array): string {
  return String.fromCharCode(...data);
}

function decodePng(uri: string): Uint8Array {
  const bytes = decodeBase64(uri.slice("data:image/png;base64,".length));
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  let offset = 8;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes.subarray(offset + 4, offset + 8));
    if (type === "IDAT") {
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const inflated = inflateStored(concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  const stride = width * 4;
  for (let row = 0; row < height; row += 1) {
    rgba.set(inflated.subarray(row * (1 + stride) + 1, row * (1 + stride) + 1 + stride), row * stride);
  }
  return rgba;
}

function inflateStored(zlib: Uint8Array): Uint8Array {
  let offset = 2;
  const parts: Uint8Array[] = [];
  while (offset + 5 <= zlib.length) {
    const header = zlib[offset] ?? 0;
    const size = (zlib[offset + 1] ?? 0) | ((zlib[offset + 2] ?? 0) << 8);
    parts.push(zlib.subarray(offset + 5, offset + 5 + size));
    offset += 5 + size;
    if ((header & 1) === 1) {
      break;
    }
  }
  return concat(parts);
}

function decodeBase64(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = value.replace(/=+$/, "");
  const out: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const group =
      (alphabet.indexOf(clean[index] ?? "A") << 18) |
      (alphabet.indexOf(clean[index + 1] ?? "A") << 12) |
      (alphabet.indexOf(clean[index + 2] ?? "A") << 6) |
      alphabet.indexOf(clean[index + 3] ?? "A");
    out.push((group >> 16) & 255);
    if (index + 2 < clean.length) {
      out.push((group >> 8) & 255);
    }
    if (index + 3 < clean.length) {
      out.push(group & 255);
    }
  }
  return Uint8Array.from(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
