import { useEffect, useState } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { MessageBlock } from "../api";
import { colors } from "../theme/tokens";
import { IconClose, IconShield } from "../ui/icons";

// Client-side bytes cache: one fetch per attachment no matter how often the
// thread re-renders or refreshes. Keyed messageId:index, process-lifetime.
const blobCache = new Map<string, string>();

/**
 * Renders one rich MessageBlock inside a bubble.
 * Why: send_message turns carry text/image/code/file/widget payloads; the
 * thread must show them inline like Grok instead of raw JSON or bare URLs.
 * Oversized images arrive as blobRefs (bytes stripped from lists) and resolve
 * lazily through fetchBlob; everything else renders inline.
 * Input: block + optional approve/deny handlers + blob fetcher.
 * Output: the block view. Unknown widgets fall back to a summary line.
 */
export function BlockView({
  block,
  onApprove,
  onDeny,
  onSubmitPoll,
  onSubmitSecret,
  fetchBlob,
}: {
  block: MessageBlock;
  onApprove?: () => void;
  onDeny?: () => void;
  onSubmitPoll?: (text: string) => void;
  onSubmitSecret?: (name: string, secret: string) => Promise<void>;
  fetchBlob?: (messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>;
}) {
  if (block.kind === "text") return <RichText text={block.markdown} />;
  if (block.kind === "image") {
    const inline = block.previewUrl || block.url;
    if (inline) {
      return (
        <View style={styles.mediaWrap}>
          <Image source={{ uri: inline }} style={styles.image} accessibilityLabel={block.alt ?? "Shared image"} />
          {block.alt ? <Text style={styles.caption}>{block.alt}</Text> : null}
        </View>
      );
    }
    if (block.blobRef && fetchBlob) {
      return <LazyBlobImage blobRef={block.blobRef} alt={block.alt} fetchBlob={fetchBlob} />;
    }
    return (
      <View style={styles.mediaWrap}>
        <Text style={styles.caption}>{block.alt ?? "Shared image"}</Text>
      </View>
    );
  }
  if (block.kind === "code") {
    return (
      <View style={styles.codeWrap}>
        {block.language ? <Text style={styles.codeLang}>{block.language}</Text> : null}
        <Text style={styles.code}>{block.code}</Text>
      </View>
    );
  }
  if (block.kind === "file") {
    return (
      <Pressable style={styles.fileWrap} onPress={() => void Linking.openURL(block.url)}>
        <Text style={styles.fileName}>{block.name}</Text>
        <Text style={styles.fileHint}>Tap to open</Text>
      </Pressable>
    );
  }
  return (
    <WidgetView
      widget={block.widget}
      props={block.props}
      onApprove={onApprove}
      onDeny={onDeny}
      onSubmitPoll={onSubmitPoll}
      onSubmitSecret={onSubmitSecret}
    />
  );
}

/**
 * Resolves and renders one stripped image on demand.
 * Why: keeps thread refreshes at kilobytes; the photo loads once per process
 * lifetime and pops in when ready. A grey box holds layout meanwhile.
 * Input: blobRef + alt + fetcher. Output: image or placeholder.
 */
function LazyBlobImage({
  blobRef,
  alt,
  fetchBlob,
}: {
  blobRef: { messageId: string; index: number };
  alt?: string;
  fetchBlob: (messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>;
}) {
  const cacheKey = `${blobRef.messageId}:${blobRef.index}`;
  const [uri, setUri] = useState<string | null>(blobCache.get(cacheKey) ?? null);
  useEffect(() => {
    let live = true;
    if (blobCache.has(cacheKey)) {
      return;
    }
    void fetchBlob(blobRef.messageId, blobRef.index)
      .then((blob) => {
        const resolved = blob.previewUrl || blob.url;
        if (resolved) {
          blobCache.set(cacheKey, resolved);
          if (live) {
            setUri(resolved);
          }
        }
      })
      .catch(() => {
        // Offline or gone: placeholder stays, refresh retries via remount.
      });
    return () => {
      live = false;
    };
  }, [cacheKey, blobRef.messageId, blobRef.index, fetchBlob]);
  if (!uri) {
    return (
      <View style={styles.mediaWrap}>
        <View style={styles.imageLoading} />
        {alt ? <Text style={styles.caption}>{alt}</Text> : null}
      </View>
    );
  }
  return (
    <View style={styles.mediaWrap}>
      <Image source={{ uri }} style={styles.image} accessibilityLabel={alt ?? "Shared image"} />
      {alt ? <Text style={styles.caption}>{alt}</Text> : null}
    </View>
  );
}

/**
 * Renders markdown-lite text with linkified URLs.
 * Why: keeps the text path dependency-free while matching old link behavior.
 * Input: raw markdown-ish text. Output: wrapped text with blue links.
 */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return (
    <Text style={styles.body}>
      {parts.map((part, index) =>
        part.startsWith("http") ? (
          <Text key={index} style={styles.link} onPress={() => void Linking.openURL(part)}>
            {part}
          </Text>
        ) : (
          <Text key={index}>{part}</Text>
        ),
      )}
    </Text>
  );
}

/**
 * Renders interactive widget cards (checklist/chart/approval/agent-card,
 * poll/table/secret). Why: widgets are how agents deliver structured work
 * (plans, scores, review queues, polls, tables, secret prompts) without
 * pasting tables; approval cards wire directly to decide(), polls answer
 * into the chat, and secrets save to the write-only vault.
 * Input: widget kind + props + handlers. Output: card view or fallback text.
 */
function WidgetView({
  widget,
  props,
  onApprove,
  onDeny,
  onSubmitPoll,
  onSubmitSecret,
}: {
  widget: string;
  props: Record<string, unknown>;
  onApprove?: () => void;
  onDeny?: () => void;
  onSubmitPoll?: (text: string) => void;
  onSubmitSecret?: (name: string, secret: string) => Promise<void>;
}) {
  if (widget === "checklist") {
    const items = Array.isArray(props.items) ? (props.items as { label: string; done?: boolean }[]) : [];
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{String(props.title ?? "Checklist")}</Text>
        {items.map((item, index) => (
          <Text key={index} style={styles.cardLine}>
            {item.done ? "✅" : "⬜"} {item.label}
          </Text>
        ))}
      </View>
    );
  }
  if (widget === "chart") {
    const values = Array.isArray(props.values) ? (props.values as number[]) : [];
    const max = Math.max(1, ...values);
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{String(props.title ?? "Chart")}</Text>
        {values.map((value, index) => (
          <View key={index} style={styles.barRow}>
            <View style={[styles.bar, { flex: Math.max(0.05, value / max) }]} />
            <Text style={styles.barValue}>{String(value)}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (widget === "approval") {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{String(props.title ?? "Needs approval")}</Text>
        {props.detail ? <Text style={styles.cardLine}>{String(props.detail)}</Text> : null}
        <View style={styles.approvalRow}>
          <Pressable style={[styles.choice, styles.allow]} onPress={onApprove}>
            <Text style={styles.choiceText}>Approve</Text>
          </Pressable>
          <Pressable style={[styles.choice, styles.deny]} onPress={onDeny}>
            <Text style={styles.choiceText}>Deny</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  if (widget === "agent-card") {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🤖 {String(props.label ?? props.name ?? "Subagent")}</Text>
        <Text style={styles.cardLine}>Specialist joined the room. Mention @{String(props.name ?? "")} to task it.</Text>
      </View>
    );
  }
  if (widget === "poll") {
    return (
      <PollWidget
        title={String(props.title ?? props.question ?? "Pick one")}
        description={typeof props.description === "string" ? props.description : ""}
        options={parsePollOptions(props.options)}
        submitLabel={typeof props.submitLabel === "string" ? props.submitLabel : "Submit"}
        hint={typeof props.hint === "string" ? props.hint : "Or answer in the chat below"}
        onSubmit={onSubmitPoll}
      />
    );
  }
  if (widget === "table") {
    return (
      <TableWidget
        title={typeof props.title === "string" ? props.title : ""}
        columns={parseStringArray(props.columns)}
        rows={Array.isArray(props.rows) ? props.rows.map((row) => parseStringArray(row)) : []}
        aligns={parseAligns(props.aligns)}
        note={typeof props.note === "string" ? props.note : ""}
      />
    );
  }
  if (widget === "secret") {
    return (
      <SecretWidget
        title={String(props.title ?? "Password")}
        description={typeof props.description === "string" ? props.description : ""}
        envName={typeof props.envName === "string" ? props.envName : ""}
        placeholder={typeof props.placeholder === "string" ? props.placeholder : "Paste your secret"}
        buttonLabel={typeof props.buttonLabel === "string" ? props.buttonLabel : "Save securely"}
        footnote={
          typeof props.footnote === "string" ? props.footnote : "Stored securely, never shown to your Bot"
        }
        onSubmit={onSubmitSecret}
      />
    );
  }
  return <Text style={styles.body}>[widget:{widget}]</Text>;
}

const POLL_LETTERS = "ABCDEFGHIJKLMNOP";

type PollOption = { label: string; danger: boolean };

/** Normalizes poll options. Input: string[] or {label, danger}[]. Output: options. */
function parsePollOptions(raw: unknown): PollOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    if (typeof item === "string") {
      return item.trim() ? [{ label: item, danger: false }] : [];
    }
    if (item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string") {
      const label = ((item as { label: string }).label ?? "").trim();
      return label ? [{ label, danger: (item as { danger?: unknown }).danger === true }] : [];
    }
    return [];
  });
}

/** Normalizes a string array prop. Input: unknown. Output: trimmed strings. */
function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === "string").map((item) => item.trim());
}

/** Normalizes column aligns. Input: unknown. Output: per-column aligns or null. */
function parseAligns(raw: unknown): ("left" | "center" | "right")[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const aligns = raw.map((item) => (item === "center" || item === "right" ? item : "left"));
  return aligns.length > 0 ? aligns : null;
}

/**
 * Renders a multi-select poll card whose answer posts into the chat.
 * Why: "or answer in the chat below" — tapping options + Submit is the fast
 * path for structured picks (unlock lists, holds), typing stays available.
 * Danger options (holds) are exclusive: picking one clears the rest.
 * Input: title, description, options, labels, handlers. Output: the card.
 */
function PollWidget({
  title,
  description,
  options,
  submitLabel,
  hint,
  onSubmit,
}: {
  title: string;
  description: string;
  options: PollOption[];
  submitLabel: string;
  hint: string;
  onSubmit?: (text: string) => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  /** Toggles one option, keeping danger picks exclusive. */
  function toggle(index: number): void {
    if (submitted) {
      return;
    }
    setSelected((current) => {
      if (current.includes(index)) {
        return current.filter((picked) => picked !== index);
      }
      const next = options[index]?.danger ? [index] : [...current.filter((picked) => !options[picked]?.danger), index];
      return next;
    });
  }

  function submit(): void {
    if (selected.length === 0 || submitted || !onSubmit) {
      return;
    }
    const labels = selected
      .slice()
      .sort((a, b) => a - b)
      .map((index) => options[index]?.label ?? "")
      .filter((label) => label.length > 0);
    if (labels.length === 0) {
      return;
    }
    onSubmit(labels.join(", "));
    setSubmitted(true);
  }

  if (dismissed) {
    return <Text style={styles.dismissed}>Poll dismissed.</Text>;
  }
  const ready = selected.length > 0 && !submitted;
  return (
    <View style={styles.pollCard}>
      <View style={styles.pollHead}>
        <Text style={styles.pollTitle}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss poll" onPress={() => setDismissed(true)} style={styles.pollX}>
          <IconClose />
        </Pressable>
      </View>
      {description ? <Text style={styles.pollDesc}>{description}</Text> : null}
      <View style={styles.pollOptions}>
        {options.map((option, index) => {
          const on = selected.includes(index);
          const letter = POLL_LETTERS[index] ?? String(index + 1);
          return (
            <Pressable
              key={index}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${letter}. ${option.label}`}
              onPress={() => toggle(index)}
              style={[styles.pollRow, on ? styles.pollRowOn : null, index > 0 ? styles.pollDivider : null]}
            >
              <View style={[styles.pollLetter, on ? styles.pollLetterOn : null]}>
                <Text style={[styles.pollLetterText, on ? styles.pollLetterTextOn : null]}>{letter}</Text>
              </View>
              <Text style={[styles.pollLabel, option.danger ? styles.pollDanger : null]} numberOfLines={2}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {hint ? <Text style={styles.pollHint}>{hint}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={!ready}
        onPress={submit}
        style={[styles.pollSubmit, ready ? styles.pollSubmitReady : null]}
      >
        <Text style={[styles.pollSubmitText, ready ? styles.pollSubmitTextReady : null]}>
          {submitted ? "Submitted" : submitLabel}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Renders a data table card with an optional closing note.
 * Why: agents deliver audits and lists as tables; plain text loses columns.
 * Input: title, columns, rows, aligns, note. Output: the table card.
 */
function TableWidget({
  title,
  columns,
  rows,
  aligns,
  note,
}: {
  title: string;
  columns: string[];
  rows: string[][];
  aligns: ("left" | "center" | "right")[] | null;
  note: string;
}) {
  const alignFor = (index: number): "left" | "center" | "right" => {
    if (aligns && aligns[index]) {
      return aligns[index] as "left" | "center" | "right";
    }
    return index === columns.length - 1 && columns.length > 1 ? "right" : "left";
  };
  const flexFor = (index: number): number => (index === 0 ? 1.4 : 1);
  return (
    <View style={styles.pollCard}>
      {title ? <Text style={styles.pollTitle}>{title}</Text> : null}
      <View style={styles.tableHead}>
        {columns.map((column, index) => (
          <Text key={index} style={[styles.tableHeader, { flex: flexFor(index), textAlign: alignFor(index) }]} numberOfLines={1}>
            {column}
          </Text>
        ))}
      </View>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.tableRow}>
          {columns.map((column, colIndex) => (
            <Text key={colIndex} style={[styles.tableCell, { flex: flexFor(colIndex), textAlign: alignFor(colIndex) }]} numberOfLines={1}>
              {row[colIndex] ?? ""}
            </Text>
          ))}
        </View>
      ))}
      {note ? <Text style={styles.tableNote}>{note}</Text> : null}
    </View>
  );
}

/**
 * Renders a masked secret prompt whose value saves to the write-only vault.
 * Why: bots need tokens/passwords that must never appear in chat — the
 * input is masked, the button posts to /secrets, and the value clears.
 * Input: labels, env name, submit handler. Output: the secret card.
 */
function SecretWidget({
  title,
  description,
  envName,
  placeholder,
  buttonLabel,
  footnote,
  onSubmit,
}: {
  title: string;
  description: string;
  envName: string;
  placeholder: string;
  buttonLabel: string;
  footnote: string;
  onSubmit?: (name: string, secret: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = value.length > 0 && !busy && !!onSubmit;

  function change(text: string): void {
    setValue(text);
    setSaved(false);
  }

  function save(): void {
    if (!ready || !onSubmit) {
      return;
    }
    setBusy(true);
    void onSubmit(envName || title, value)
      .then(() => {
        setValue("");
        setSaved(true);
      })
      .catch(() => {
        // The app surfaces the error as a note; the typed value stays.
      })
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <View style={styles.pollCard}>
      <Text style={styles.pollTitle}>{title}</Text>
      {description ? <Text style={styles.pollDesc}>{description}</Text> : null}
      <View style={styles.secretRow}>
        <TextInput
          value={value}
          onChangeText={change}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          keyboardAppearance="dark"
          style={styles.secretInput}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!ready}
          onPress={save}
          style={[styles.secretSave, ready ? styles.secretSaveReady : null]}
        >
          <Text style={[styles.secretSaveText, ready ? styles.secretSaveTextReady : null]}>
            {saved ? "Saved" : buttonLabel}
          </Text>
        </Pressable>
      </View>
      {footnote ? (
        <View style={styles.secretFoot}>
          <IconShield />
          <Text style={styles.secretFootText}>{footnote}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { color: colors.text, fontSize: 16, lineHeight: 24 },
  link: { color: colors.link },
  mediaWrap: { gap: 6 },
  image: { width: 240, height: 180, borderRadius: 12, backgroundColor: colors.control },
  caption: { color: colors.muted, fontSize: 13 },
  imageLoading: { width: 240, height: 180, borderRadius: 12, backgroundColor: colors.control, opacity: 0.6 },
  codeWrap: { backgroundColor: colors.control, borderRadius: 10, padding: 10, gap: 4 },
  codeLang: { color: colors.muted, fontSize: 12 },
  code: { color: colors.text, fontFamily: "monospace", fontSize: 13 },
  fileWrap: { backgroundColor: colors.control, borderRadius: 10, padding: 12, gap: 2 },
  fileName: { color: colors.text, fontWeight: "600" },
  fileHint: { color: colors.muted, fontSize: 12 },
  card: { backgroundColor: colors.control, borderRadius: 12, padding: 12, gap: 6, minWidth: 220 },
  cardTitle: { color: colors.text, fontWeight: "700", fontSize: 15 },
  cardLine: { color: colors.text, fontSize: 14, lineHeight: 20 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  bar: { height: 10, borderRadius: 5, backgroundColor: colors.link },
  barValue: { color: colors.muted, fontSize: 12, width: 40 },
  approvalRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  choice: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  allow: { backgroundColor: "#1d5c2e" },
  deny: { backgroundColor: "#6e2b2b" },
  choiceText: { color: "#fff", fontWeight: "700" },
  pollCard: { gap: 8, minWidth: 240 },
  pollHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  pollTitle: { color: colors.text, fontSize: 17, fontWeight: "700", flex: 1 },
  pollX: { width: 32, height: 32, alignItems: "center", justifyContent: "center", opacity: 0.6 },
  pollDesc: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  pollOptions: { backgroundColor: colors.bg, borderRadius: 14, overflow: "hidden" },
  pollRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  pollRowOn: { backgroundColor: "#1d3a5f" },
  pollDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  pollLetter: { width: 28, height: 28, borderRadius: 8, backgroundColor: colors.line, alignItems: "center", justifyContent: "center" },
  pollLetterOn: { backgroundColor: colors.link },
  pollLetterText: { color: colors.muted, fontSize: 15, fontWeight: "700" },
  pollLetterTextOn: { color: "#fff" },
  pollLabel: { color: colors.text, fontSize: 17, flex: 1 },
  pollDanger: { color: colors.danger },
  pollHint: { color: colors.muted, fontSize: 14 },
  pollSubmit: { height: 48, borderRadius: 14, backgroundColor: colors.control, alignItems: "center", justifyContent: "center", marginTop: 2 },
  pollSubmitReady: { backgroundColor: colors.link },
  pollSubmitText: { color: colors.muted, fontSize: 16, fontWeight: "600" },
  pollSubmitTextReady: { color: "#fff" },
  dismissed: { color: colors.muted, fontSize: 14 },
  tableHead: { flexDirection: "row", paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tableHeader: { color: colors.text, fontSize: 14, fontWeight: "700" },
  tableRow: { flexDirection: "row", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tableCell: { color: colors.text, fontSize: 14 },
  tableNote: { color: colors.text, fontSize: 16, lineHeight: 24, marginTop: 8 },
  secretRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  secretInput: { flex: 1, backgroundColor: colors.bg, color: colors.text, borderRadius: 12, height: 48, paddingHorizontal: 14, fontSize: 16 },
  secretSave: { height: 48, borderRadius: 24, backgroundColor: colors.control, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  secretSaveReady: { backgroundColor: colors.text },
  secretSaveText: { color: colors.muted, fontSize: 16, fontWeight: "600" },
  secretSaveTextReady: { color: colors.bg },
  secretFoot: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  secretFootText: { color: colors.muted, fontSize: 13, flex: 1 },
});
