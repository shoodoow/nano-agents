import { Directory, File, Paths } from "expo-file-system";

const INDEX_NAME = "index.json";
const DATA_PREFIX = /^data:image\/png;base64,/;

type ThumbIndex = Record<string, string>;

function marksDir(): Directory {
  return new Directory(Paths.cache, "nano-mark-thumbs");
}

function indexFile(): File {
  return new File(marksDir(), INDEX_NAME);
}

function safeFileName(key: string): string {
  const slug = key.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 48);
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `m-${hash.toString(16)}-${slug || "mark"}.png`;
}

let indexCache: ThumbIndex | null = null;

async function readIndex(): Promise<ThumbIndex> {
  if (indexCache) return indexCache;
  const file = indexFile();
  if (!file.exists) {
    indexCache = {};
    return indexCache;
  }
  try {
    indexCache = JSON.parse(await file.text()) as ThumbIndex;
    return indexCache;
  } catch {
    indexCache = {};
    return indexCache;
  }
}

let indexWriteTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIndexWrite(): void {
  if (indexWriteTimer) return;
  indexWriteTimer = setTimeout(() => {
    indexWriteTimer = null;
    if (!indexCache) return;
    const dir = marksDir();
    if (!dir.exists) dir.create({ intermediates: true });
    const file = indexFile();
    if (file.exists) file.delete();
    file.create();
    file.write(JSON.stringify(indexCache));
  }, 400);
}

/**
 * Loads baked mark PNG paths from disk into the in-memory cache.
 */
export async function hydrateMarkThumbsFromDisk(load: (key: string, fileUri: string) => void): Promise<void> {
  const dir = marksDir();
  if (!dir.exists) return;
  const index = await readIndex();
  indexCache = index;
  for (const [key, name] of Object.entries(index)) {
    const file = new File(dir, name);
    if (file.exists) load(key, file.uri);
  }
}

/**
 * Writes one bakery PNG to disk and returns its file URI.
 */
export function persistMarkThumb(key: string, dataUrl: string): string | null {
  const match = DATA_PREFIX.exec(dataUrl);
  if (!match) return null;
  const base64 = dataUrl.slice(match[0].length);
  const dir = marksDir();
  if (!dir.exists) dir.create({ intermediates: true });
  const name = safeFileName(key);
  const file = new File(dir, name);
  if (file.exists) file.delete();
  file.create();
  const raw = globalThis.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  file.write(bytes);
  void readIndex().then((index) => {
    index[key] = name;
    indexCache = index;
    scheduleIndexWrite();
  });
  return file.uri;
}
