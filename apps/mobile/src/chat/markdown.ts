export type MarkdownBlock =
  | { kind: "text"; text: string }
  | { kind: "table"; columns: string[]; rows: string[][] };

/** Splits chat markdown into prose and GFM tables so pipes are not shown raw. */
export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = joinBrokenRows(source).split("\n");
  const blocks: MarkdownBlock[] = [];
  const prose: string[] = [];
  const flush = (): void => {
    const text = prose.join("\n").trim();
    prose.length = 0;
    if (text) blocks.push({ kind: "text", text });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const columns = tableRow(lines[index] ?? "");
    if (columns && isSeparator(lines[index + 1] ?? "")) {
      flush();
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const row = tableRow(lines[index] ?? "");
        if (!row) break;
        rows.push(Array.from({ length: columns.length }, (_, cell) => row[cell] ?? ""));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "table", columns, rows });
    } else {
      prose.push(lines[index] ?? "");
    }
  }
  flush();
  return blocks.length > 0 ? blocks : [{ kind: "text", text: source }];
}

/** Pulls a cell that wrapped onto the next line back into its pipe row. */
function joinBrokenRows(source: string): string {
  const joined: string[] = [];
  let buffer = "";
  for (const line of source.split("\n")) {
    const piece = buffer ? `${buffer} ${line.trim()}` : line;
    const trimmed = piece.trim();
    if (trimmed.startsWith("|") && !trimmed.endsWith("|")) {
      buffer = piece;
      continue;
    }
    joined.push(buffer ? piece : line);
    buffer = "";
  }
  if (buffer) joined.push(buffer);
  return joined.join("\n");
}

function tableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isSeparator(line: string): boolean {
  const cells = tableRow(line);
  return Boolean(cells?.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

const URL_TAIL = ".,;:!?'\"»)]}>*_`";

/**
 * Drops sentence punctuation a bare URL swallowed ("see https://a.b/c." → no dot).
 * A closing paren stays when the URL opened one, e.g. a Wikipedia title.
 */
export function trimUrl(raw: string): string {
  let url = raw;
  while (url.length > 0 && URL_TAIL.includes(url[url.length - 1]!)) {
    if (url.endsWith(")") && url.split("(").length > url.split(")").length - 1) break;
    url = url.slice(0, -1);
  }
  return url;
}

/** Lists the distinct links in one message text, in reading order, for preview cards. */
export function extractUrls(source: string, limit = 3): string[] {
  const found: string[] = [];
  const pattern = /\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null && found.length < limit) {
    const url = match[1] ?? trimUrl(match[2] ?? "");
    if (url.length > 10 && !found.includes(url)) found.push(url);
  }
  return found;
}

type PlainBlock =
  | { kind: "text"; markdown: string }
  | { kind: "code"; code: string }
  | { kind: "file"; name: string }
  | { kind: "image"; alt?: string }
  | { kind: "widget"; widget: string; props: Record<string, unknown> };

/**
 * Flattens one message to the text a person expects on the clipboard.
 * Why: Copy and Select Text work on words, so bold/code markers come off and
 * a table widget becomes tab-separated rows that paste into a sheet.
 */
export function messagePlainText(blocks: readonly PlainBlock[] | null | undefined, body: string): string {
  if (!blocks || blocks.length === 0) return stripInlineMarkdown(body);
  const parts = blocks.map((block) => {
    if (block.kind === "text") return stripInlineMarkdown(block.markdown);
    if (block.kind === "code") return block.code;
    if (block.kind === "file") return block.name;
    if (block.kind === "image") return block.alt ?? "";
    const title = typeof block.props.title === "string" ? block.props.title : "";
    if (block.widget !== "table") return title;
    const line = (cells: unknown): string => (Array.isArray(cells) ? cells.map((cell) => String(cell ?? "")).join("\t") : "");
    const rows = Array.isArray(block.props.rows) ? block.props.rows.map(line) : [];
    return [title, line(block.props.columns), ...rows].filter((row) => row.length > 0).join("\n");
  });
  return parts.filter((part) => part.trim().length > 0).join("\n\n") || stripInlineMarkdown(body);
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");
}
