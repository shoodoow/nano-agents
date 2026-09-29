export type RfbEvent = { type: "send"; data: Uint8Array } | { type: "frame"; uri: string } | { type: "error"; message: string };

export type FrameSize = { width: number; height: number };
export type ViewSize = { width: number; height: number };

/**
 * Reads one noVNC byte stream and paints Raw framebuffer updates.
 * Input: websocket message bytes, in order.
 * Output: bytes to send back, a PNG data URI when a frame is complete, or an error.
 */
export class RfbReader {
  size: FrameSize | null = null;
  rgba = new Uint8Array(0);
  private buf = new Uint8Array(0);
  private offset = 0;
  private step: "version" | "security-count" | "security-types" | "security-result" | "init" | "name" | "messages" = "version";
  private securityCount = 0;
  private nameLength = 0;
  private pixels = new Uint8Array(0);
  private nextFrameAt = 0;
  private waiting = false;

  push(chunk: Uint8Array): RfbEvent[] {
    this.append(chunk);
    const events: RfbEvent[] = [];
    let progressed = true;
    while (progressed) {
      progressed = this.consume(events);
    }
    return events;
  }

  /**
   * Says how long to wait before a held frame should be shown.
   * Input: the current time in milliseconds.
   * Output: the delay, or null when nothing is waiting.
   */
  dueIn(now: number): number | null {
    if (!this.waiting) {
      return null;
    }
    return Math.max(0, this.nextFrameAt - now);
  }

  /**
   * Publishes a frame that was held back so the screen can keep up.
   * Input: the current time in milliseconds.
   * Output: the picture and the next framebuffer request, or nothing when it is too soon.
   */
  pump(now: number): RfbEvent[] {
    if (!this.waiting || !this.size || now < this.nextFrameAt) {
      return [];
    }
    this.waiting = false;
    this.nextFrameAt = now + 150;
    return [
      { type: "frame", uri: pngDataUri(this.size.width, this.size.height, this.pixels) },
      { type: "send", data: framebufferRequest(this.size, 1) },
    ];
  }

  /**
   * Builds a pointer event for the remote display.
   * Input: framebuffer coordinates and a button mask. 1 is the left button.
   * Output: the 6-byte RFB message.
   */
  pointer(x: number, y: number, buttons: number): Uint8Array {
    const data = new Uint8Array(6);
    data[0] = 5;
    data[1] = buttons & 0xff;
    write16(data, 2, clamp(x));
    write16(data, 4, clamp(y));
    return data;
  }

  /**
   * Builds a key press or release for the remote display.
   * Input: an X keysym and whether the key is down.
   * Output: the 8-byte RFB message.
   */
  key(keysym: number, down: boolean): Uint8Array {
    const data = new Uint8Array(8);
    data[0] = 4;
    data[1] = down ? 1 : 0;
    new DataView(data.buffer).setUint32(4, keysym);
    return data;
  }

  private append(chunk: Uint8Array): void {
    const rest = this.buf.length - this.offset;
    const next = new Uint8Array(rest + chunk.length);
    next.set(this.buf.subarray(this.offset));
    next.set(chunk, rest);
    this.buf = next;
    this.offset = 0;
  }

  private consume(events: RfbEvent[]): boolean {
    if (this.step === "version") {
      const bytes = this.take(12);
      if (!bytes) {
        return false;
      }
      events.push({ type: "send", data: text("RFB 003.008\n") });
      this.step = "security-count";
      return true;
    }
    if (this.step === "security-count") {
      const bytes = this.take(1);
      if (!bytes) {
        return false;
      }
      this.securityCount = bytes[0] ?? 0;
      this.step = "security-types";
      return true;
    }
    if (this.step === "security-types") {
      const bytes = this.take(this.securityCount);
      if (!bytes) {
        return false;
      }
      if (![...bytes].includes(1)) {
        events.push({ type: "error", message: "The desktop requires a password." });
        this.step = "messages";
        return false;
      }
      events.push({ type: "send", data: new Uint8Array([1]) });
      this.step = "security-result";
      return true;
    }
    if (this.step === "security-result") {
      const bytes = this.take(4);
      if (!bytes) {
        return false;
      }
      if (read32(bytes, 0) !== 0) {
        events.push({ type: "error", message: "The desktop refused the connection." });
        return false;
      }
      events.push({ type: "send", data: new Uint8Array([1]) });
      this.step = "init";
      return true;
    }
    if (this.step === "init") {
      const bytes = this.take(24);
      if (!bytes) {
        return false;
      }
      const width = read16(bytes, 0);
      const height = read16(bytes, 2);
      this.size = { width, height };
      this.pixels = new Uint8Array(width * height * 4);
      this.nameLength = read32(bytes, 20);
      this.step = "name";
      return true;
    }
    if (this.step === "name") {
      const bytes = this.take(this.nameLength);
      if (!bytes) {
        return false;
      }
      const size = this.size ?? { width: 0, height: 0 };
      events.push({ type: "send", data: concat(setPixelFormat(), setEncodings(), framebufferRequest(size, 0)) });
      this.step = "messages";
      return true;
    }
    return this.consumeMessage(events);
  }

  private consumeMessage(events: RfbEvent[]): boolean {
    const kind = this.peek(1);
    if (!kind) {
      return false;
    }
    const type = kind[0] ?? 0;
    if (type === 0) {
      return this.consumeFramebuffer(events);
    }
    if (type === 1) {
      return this.take(1) !== null;
    }
    if (type === 2) {
      const header = this.peek(6);
      if (!header) {
        return false;
      }
      const count = read16(header, 4);
      return this.take(6 + count * 6) !== null;
    }
    if (type === 3) {
      const header = this.peek(8);
      if (!header) {
        return false;
      }
      const length = read32(header, 4);
      if (length > 1_000_000) {
        events.push({ type: "error", message: "The desktop sent a clipboard that is too large." });
        return false;
      }
      return this.take(8 + length) !== null;
    }
    events.push({ type: "error", message: "The desktop sent an unknown message." });
    return false;
  }

  private consumeFramebuffer(events: RfbEvent[]): boolean {
    const header = this.peek(4);
    if (!header) {
      return false;
    }
    const rectangles = read16(header, 2);
    let cursor = 4;
    for (let index = 0; index < rectangles; index += 1) {
      const rect = this.peek(cursor + 12);
      if (!rect) {
        return false;
      }
      const width = read16(rect, cursor + 4);
      const height = read16(rect, cursor + 6);
      const encoding = read32(rect, cursor + 8) | 0;
      const pixels = rectangleBytes(encoding, width, height);
      if (pixels === null) {
        events.push({ type: "error", message: "The desktop used an unsupported picture encoding." });
        return false;
      }
      if (this.available() < cursor + 12 + pixels) {
        return false;
      }
      cursor += 12 + pixels;
    }
    const message = this.take(cursor);
    if (!message || !this.size) {
      return false;
    }
    let start = 4;
    let painted = false;
    for (let index = 0; index < rectangles; index += 1) {
      const x = read16(message, start);
      const y = read16(message, start + 2);
      const width = read16(message, start + 4);
      const height = read16(message, start + 6);
      const encoding = read32(message, start + 8) | 0;
      const pixels = rectangleBytes(encoding, width, height) ?? 0;
      if (encoding === 0) {
        paint(this.pixels, this.size, x, y, width, height, message.subarray(start + 12, start + 12 + width * height * 4));
        painted = true;
      }
      start += 12 + pixels;
    }
    if (!painted) {
      events.push({ type: "send", data: framebufferRequest(this.size, 1) });
      return true;
    }
    const now = Date.now();
    if (now >= this.nextFrameAt) {
      this.waiting = false;
      this.nextFrameAt = now + 150;
      this.rgba = this.pixels.slice();
      events.push({ type: "frame", uri: pngDataUri(this.size.width, this.size.height, this.pixels) });
      events.push({ type: "send", data: framebufferRequest(this.size, 1) });
    } else {
      this.waiting = true;
    }
    return true;
  }

  private available(): number {
    return this.buf.length - this.offset;
  }

  private peek(n: number): Uint8Array | null {
    if (this.available() < n) {
      return null;
    }
    return this.buf.subarray(this.offset, this.offset + n);
  }

  private take(n: number): Uint8Array | null {
    const bytes = this.peek(n);
    if (!bytes) {
      return null;
    }
    this.offset += n;
    return bytes;
  }
}

/**
 * Maps a touch on the fitted picture to a framebuffer pixel.
 * Input: the touch point, the view size, and the framebuffer size.
 * Output: the pixel, or null when the touch is in the empty margin.
 */
export function mapPointer(locationX: number, locationY: number, view: ViewSize, frame: FrameSize): { x: number; y: number } | null {
  if (view.width <= 0 || view.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return null;
  }
  const scale = Math.min(view.width / frame.width, view.height / frame.height);
  const drawnWidth = frame.width * scale;
  const drawnHeight = frame.height * scale;
  const offsetX = (view.width - drawnWidth) / 2;
  const offsetY = (view.height - drawnHeight) / 2;
  const x = Math.floor((locationX - offsetX) / scale);
  const y = Math.floor((locationY - offsetY) / scale);
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    return null;
  }
  return { x, y };
}

function rectangleBytes(encoding: number, width: number, height: number): number | null {
  if (encoding === 0) {
    return width * height * 4;
  }
  if (encoding === -239) {
    return width * height * 4 + Math.ceil(width / 8) * height;
  }
  return null;
}

function paint(pixels: Uint8Array, frame: FrameSize, x: number, y: number, width: number, height: number, raw: Uint8Array): void {
  for (let row = 0; row < height; row += 1) {
    const targetY = y + row;
    if (targetY < 0 || targetY >= frame.height) {
      continue;
    }
    for (let column = 0; column < width; column += 1) {
      const targetX = x + column;
      if (targetX < 0 || targetX >= frame.width) {
        continue;
      }
      const source = (row * width + column) * 4;
      const target = (targetY * frame.width + targetX) * 4;
      pixels[target] = raw[source + 2] ?? 0;
      pixels[target + 1] = raw[source + 1] ?? 0;
      pixels[target + 2] = raw[source] ?? 0;
      pixels[target + 3] = 255;
    }
  }
}

function setPixelFormat(): Uint8Array {
  const data = new Uint8Array(20);
  data[0] = 0;
  data[4] = 32;
  data[5] = 24;
  data[7] = 1;
  data[9] = 255;
  data[11] = 255;
  data[13] = 255;
  data[14] = 16;
  data[15] = 8;
  return data;
}

function setEncodings(): Uint8Array {
  const data = new Uint8Array(8);
  data[0] = 2;
  data[3] = 1;
  return data;
}

function framebufferRequest(frame: FrameSize, incremental: number): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = 3;
  data[1] = incremental;
  write16(data, 6, frame.width);
  write16(data, 8, frame.height);
  return data;
}

function pngDataUri(width: number, height: number, rgba: Uint8Array): string {
  const preview = downscale(width, height, rgba);
  return `data:image/png;base64,${base64(encodePng(preview.width, preview.height, preview.rgba))}`;
}

function downscale(width: number, height: number, rgba: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (width < 800 || height < 800) {
    return { width, height, rgba };
  }
  const nextWidth = width >> 1;
  const nextHeight = height >> 1;
  const out = new Uint8Array(nextWidth * nextHeight * 4);
  for (let y = 0; y < nextHeight; y += 1) {
    const sourceRow = y * 2 * width;
    for (let x = 0; x < nextWidth; x += 1) {
      const source = (sourceRow + x * 2) * 4;
      const target = (y * nextWidth + x) * 4;
      out[target] = rgba[source] ?? 0;
      out[target + 1] = rgba[source + 1] ?? 0;
      out[target + 2] = rgba[source + 2] ?? 0;
      out[target + 3] = rgba[source + 3] ?? 0;
    }
  }
  return { width: nextWidth, height: nextHeight, rgba: out };
}

/**
 * Encodes one RGBA picture as a PNG.
 * Input: the width, height, and tightly packed RGBA bytes.
 * Output: the PNG file bytes.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let row = 0; row < height; row += 1) {
    const target = row * (1 + stride);
    raw[target] = 0;
    raw.set(rgba.subarray(row * stride, row * stride + stride), target + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return concat(signature, pngChunk("IHDR", header), pngChunk("IDAT", zlibStore(raw)), pngChunk("IEND", new Uint8Array(0)));
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(text(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0);
  return out;
}

function zlibStore(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  let offset = 0;
  while (offset < data.length) {
    const size = Math.min(65535, data.length - offset);
    const last = offset + size >= data.length;
    const block = new Uint8Array(5 + size);
    block[0] = last ? 1 : 0;
    block[1] = size & 0xff;
    block[2] = (size >> 8) & 0xff;
    const complement = size ^ 0xffff;
    block[3] = complement & 0xff;
    block[4] = (complement >> 8) & 0xff;
    block.set(data.subarray(offset, offset + size), 5);
    parts.push(block);
    offset += size;
  }
  const sum = new Uint8Array(4);
  new DataView(sum.buffer).setUint32(0, adler32(data));
  parts.push(sum);
  return concat(...parts);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function base64(data: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let index = 0; index < data.length; index += 3) {
    const first = data[index] ?? 0;
    const second = data[index + 1] ?? 0;
    const third = data[index + 2] ?? 0;
    const group = (first << 16) | (second << 8) | third;
    out += alphabet[(group >> 18) & 63];
    out += alphabet[(group >> 12) & 63];
    out += index + 1 < data.length ? alphabet[(group >> 6) & 63] : "=";
    out += index + 2 < data.length ? alphabet[group & 63] : "=";
  }
  return out;
}

function text(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function read16(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
}

function read32(data: Uint8Array, offset: number): number {
  return (((data[offset] ?? 0) << 24) | ((data[offset + 1] ?? 0) << 16) | ((data[offset + 2] ?? 0) << 8) | (data[offset + 3] ?? 0)) >>> 0;
}

function write16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = (value >> 8) & 0xff;
  data[offset + 1] = value & 0xff;
}

function clamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(65535, Math.floor(value));
}
