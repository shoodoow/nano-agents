/**
 * One-shot Google API helper. Core docker-execs this inside the account container.
 *
 * Why this exists: Gmail, Calendar, and Drive are not MCP servers, and the
 * refresh token plus Google client secret stay on the core. Core writes a
 * short-lived access token to /var/nano/mcp/secrets/google, then this script
 * calls Google and exits. It does not listen.
 *
 * Reads JSON from stdin: { slug, tool, args }. Prints JSON.
 */
import { readFile } from "node:fs/promises";

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function google(path, token, init = {}) {
  const response = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 400) || `Google HTTP ${response.status}`);
  return text ? JSON.parse(text) : {};
}

function clip(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 8000 ? `${text.slice(0, 8000)}\n[truncated]` : text;
}

async function gmail(tool, args, token) {
  if (tool === "search") {
    const listed = await google(`/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(String(args.query ?? ""))}`, token);
    const messages = [];
    for (const row of listed.messages ?? []) {
      const full = await google(`/gmail/v1/users/me/messages/${row.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, token);
      const headers = Object.fromEntries((full.payload?.headers ?? []).map((header) => [header.name, header.value]));
      messages.push({ id: row.id, from: headers.From ?? "", subject: headers.Subject ?? "", snippet: full.snippet ?? "" });
    }
    return { messages };
  }
  if (tool === "read") {
    const full = await google(`/gmail/v1/users/me/messages/${encodeURIComponent(String(args.id ?? ""))}?format=full`, token);
    return { id: full.id, snippet: full.snippet ?? "", body: clip(plainPart(full.payload) || full.snippet || "") };
  }
  if (tool === "create_draft") {
    const raw = Buffer.from(`To: ${args.to}\r\nSubject: ${args.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}`).toString("base64url");
    const draft = await google("/gmail/v1/users/me/drafts", token, { method: "POST", body: JSON.stringify({ message: { raw } }) });
    return { id: draft.id, message: "Draft created. It was not sent." };
  }
  if (tool === "send") {
    if (args.draftId) {
      const sent = await google("/gmail/v1/users/me/drafts/send", token, {
        method: "POST",
        body: JSON.stringify({ id: String(args.draftId) }),
      });
      return { id: sent.id, message: "Sent." };
    }
    const raw = Buffer.from(`To: ${args.to}\r\nSubject: ${args.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}`).toString("base64url");
    const sent = await google("/gmail/v1/users/me/messages/send", token, { method: "POST", body: JSON.stringify({ raw }) });
    return { id: sent.id, message: "Sent." };
  }
  throw new Error(`Unknown Gmail tool ${tool}.`);
}

function plainPart(part) {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const child of part.parts ?? []) {
    const text = plainPart(child);
    if (text) return text;
  }
  return "";
}

async function calendar(tool, args, token) {
  if (tool === "search_events") {
    const params = new URLSearchParams({ maxResults: "10", singleEvents: "true", orderBy: "startTime" });
    if (args.query) params.set("q", String(args.query));
    if (args.timeMin) params.set("timeMin", String(args.timeMin));
    if (args.timeMax) params.set("timeMax", String(args.timeMax));
    if (!args.timeMin) params.set("timeMin", new Date().toISOString());
    const listed = await google(`/calendar/v3/calendars/primary/events?${params}`, token);
    return {
      events: (listed.items ?? []).map((event) => ({
        id: event.id,
        summary: event.summary ?? "",
        start: event.start?.dateTime || event.start?.date || "",
        end: event.end?.dateTime || event.end?.date || "",
      })),
    };
  }
  if (tool === "create_event") {
    const created = await google("/calendar/v3/calendars/primary/events", token, {
      method: "POST",
      body: JSON.stringify({
        summary: args.summary,
        start: { dateTime: args.start },
        end: { dateTime: args.end },
      }),
    });
    return { id: created.id, summary: created.summary, htmlLink: created.htmlLink };
  }
  throw new Error(`Unknown Calendar tool ${tool}.`);
}

async function drive(tool, args, token) {
  if (tool === "search") {
    const q = `name contains '${String(args.query ?? "").split("'").join("\\'")}'`;
    const listed = await google(`/drive/v3/files?pageSize=10&fields=files(id,name,mimeType)&q=${encodeURIComponent(q)}`, token);
    return { files: listed.files ?? [] };
  }
  if (tool === "read") {
    const fileId = encodeURIComponent(String(args.fileId ?? ""));
    const meta = await google(`/drive/v3/files/${fileId}?fields=id,name,mimeType,webViewLink`, token);
    let text = "";
    if (String(meta.mimeType ?? "").startsWith("text/") || meta.mimeType === "application/json") {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { authorization: `Bearer ${token}` },
      });
      text = clip(await response.text());
    }
    return { ...meta, text };
  }
  throw new Error(`Unknown Drive tool ${tool}.`);
}

async function main() {
  const request = JSON.parse(await readStdin());
  const token = (await readFile("/var/nano/mcp/secrets/google", "utf8")).trim();
  if (!token) throw new Error("This Google plugin is not connected.");
  const args = request.args ?? {};
  let result;
  if (request.slug === "gmail") result = await gmail(request.tool, args, token);
  else if (request.slug === "google-calendar") result = await calendar(request.tool, args, token);
  else if (request.slug === "google-drive") result = await drive(request.tool, args, token);
  else throw new Error(`Unknown Google plugin ${request.slug}.`);
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
