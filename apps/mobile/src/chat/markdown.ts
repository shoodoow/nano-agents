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
