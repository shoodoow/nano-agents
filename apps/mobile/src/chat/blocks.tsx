import { useEffect, useState, type ReactNode } from "react";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { MessageBlock } from "../api";
import { blocksFromMaybeWidgetText } from "@nano-agents/shared";
import { parseMarkdownBlocks } from "./markdown";
import { colors } from "../theme/tokens";
import { IconClose, IconShield } from "../ui/icons";

// Client-side bytes cache: one fetch per attachment no matter how often the
// thread re-renders or refreshes. Keyed messageId:index, process-lifetime.
const blobCache = new Map<string, string>();

/**
 * Renders one rich MessageBlock inside a bubble.
 * Why: send_message turns carry text/image/code/file/widget payloads; the
 * thread must show them inline instead of raw JSON or bare URLs.
 * Oversized images arrive as blobRefs (bytes stripped from lists) and resolve
 * lazily through fetchBlob; everything else renders inline.
 * Input: block + optional approve/deny handlers + blob fetcher.
 * Output: the block view. Unknown widgets fall back to a summary line.
 */
export function BlockView({
  block,
  messageId,
  onApprove,
  onDeny,
  onSubmitPoll,
  onQuestionPick,
  onSubmitSecret,
  fetchBlob,
}: {
  block: MessageBlock;
  messageId?: string;
  onApprove?: (approvalId?: string) => void;
  onDeny?: (approvalId?: string) => void;
  onSubmitPoll?: (text: string) => void;
  onQuestionPick?: (messageId: string, pick: { value: string; label: string }) => void;
  onSubmitSecret?: (name: string, secret: string) => Promise<void>;
  fetchBlob?: (messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>;
}) {
  if (block.kind === "text") {
    if (/\[widget:/i.test(block.markdown)) {
      const recovered = blocksFromMaybeWidgetText(block.markdown);
      if (recovered.some((row) => row.kind === "widget")) {
        return (
          <View style={{ gap: 8 }}>
            {recovered.map((row, index) => (
              <BlockView
                key={index}
                block={row}
                messageId={messageId}
                onApprove={onApprove}
                onDeny={onDeny}
                onSubmitPoll={onSubmitPoll}
                onQuestionPick={onQuestionPick}
                onSubmitSecret={onSubmitSecret}
                fetchBlob={fetchBlob}
              />
            ))}
          </View>
        );
      }
    }
    return <RichText text={block.markdown} />;
  }
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
      <Pressable
        style={styles.fileWrap}
        onPress={() => void openFileBlock(block, fetchBlob)}
      >
        <Text style={styles.fileName}>{block.name}</Text>
        <Text style={styles.fileHint}>Tap to open</Text>
      </Pressable>
    );
  }
  return (
    <WidgetView
      widget={block.widget}
      props={block.props}
      messageId={messageId}
      onApprove={onApprove}
      onDeny={onDeny}
      onSubmitPoll={onSubmitPoll}
      onQuestionPick={onQuestionPick}
      onSubmitSecret={onSubmitSecret}
    />
  );
}

/** Resolves lazy bytes, writes them to device cache, then opens the native share/preview sheet. */
export async function openFileBlock(
  block: Extract<MessageBlock, { kind: "file" }>,
  fetchBlob?: (messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>,
): Promise<void> {
  let url = block.url;
  if (!url && block.blobRef && fetchBlob) {
    url = (await fetchBlob(block.blobRef.messageId, block.blobRef.index)).url ?? "";
  }
  const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!data) {
    if (url) await Linking.openURL(url);
    return;
  }
  const raw = globalThis.atob(data[2]!);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  const safeName = block.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "attachment";
  const file = new File(Paths.cache, safeName);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType: block.mime ?? data[1], dialogTitle: `Open ${block.name}` });
  } else {
    await Linking.openURL(file.uri);
  }
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
 * Renders markdown-lite: bold, inline code, and linkified URLs.
 * Why: agents write **bold** / `code` but the phone only did URLs, so markup showed raw.
 * Input: raw markdown-ish text. Output: nested Text spans.
 */
function RichText({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);
  if (blocks.length === 1 && blocks[0]?.kind === "text") {
    return <Text style={styles.body}>{renderInlineMarkdown(blocks[0].text)}</Text>;
  }
  return (
    <View style={styles.richStack}>
      {blocks.map((block, index) =>
        block.kind === "table" ? (
          <ScrollView key={index} horizontal showsHorizontalScrollIndicator={false}>
            <View>
              <View style={styles.mdTableHead}>
                {block.columns.map((column, columnIndex) => (
                  <Text key={columnIndex} style={styles.mdTableHeader}>
                    {renderInlineMarkdown(column, `h-${index}-${columnIndex}`)}
                  </Text>
                ))}
              </View>
              {block.rows.map((row, rowIndex) => (
                <View key={rowIndex} style={styles.mdTableRow}>
                  {block.columns.map((_, columnIndex) => (
                    <Text key={columnIndex} style={styles.mdTableCell}>
                      {renderInlineMarkdown(row[columnIndex] ?? "", `c-${index}-${rowIndex}-${columnIndex}`)}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        ) : (
          <Text key={index} style={styles.body}>
            {renderInlineMarkdown(block.text, `p-${index}`)}
          </Text>
        ),
      )}
    </View>
  );
}

function renderInlineMarkdown(text: string, keyPrefix = "t"): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/\S+))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(<Text key={`${keyPrefix}-${i++}`}>{text.slice(last, match.index)}</Text>);
    }
    if (match[2] !== undefined) {
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} style={styles.mdBold}>
          {match[2]}
        </Text>,
      );
    } else if (match[3] !== undefined) {
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} style={styles.mdCode}>
          {match[3]}
        </Text>,
      );
    } else if (match[4] !== undefined && match[5] !== undefined) {
      const href = match[5];
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} style={styles.link} onPress={() => void Linking.openURL(href)}>
          {match[4]}
        </Text>,
      );
    } else if (match[6] !== undefined) {
      const href = match[6];
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} style={styles.link} onPress={() => void Linking.openURL(href)}>
          {href}
        </Text>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push(<Text key={`${keyPrefix}-${i++}`}>{text.slice(last)}</Text>);
  }
  return nodes.length > 0 ? nodes : [<Text key={`${keyPrefix}-0`}>{text}</Text>];
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
  messageId,
  onApprove,
  onDeny,
  onSubmitPoll,
  onQuestionPick,
  onSubmitSecret,
}: {
  widget: string;
  props: Record<string, unknown>;
  messageId?: string;
  onApprove?: (approvalId?: string) => void;
  onDeny?: (approvalId?: string) => void;
  onSubmitPoll?: (text: string) => void;
  onQuestionPick?: (messageId: string, pick: { value: string; label: string }) => void;
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
    const approvalId = typeof props.approvalId === "string" ? props.approvalId : undefined;
    const status = props.status === "approved" || props.status === "denied" ? props.status : null;
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{String(props.title ?? "Needs approval")}</Text>
        {props.detail ? <Text style={styles.cardLine}>{String(props.detail)}</Text> : null}
        {status ? (
          <Text style={styles.approvalStatus}>{status === "approved" ? "Approved" : "Denied"}</Text>
        ) : (
          <View style={styles.approvalRow}>
            <Pressable style={[styles.choice, styles.allow]} onPress={() => onApprove?.(approvalId)}>
              <Text style={styles.choiceText}>Approve</Text>
            </Pressable>
            <Pressable style={[styles.choice, styles.deny]} onPress={() => onDeny?.(approvalId)}>
              <Text style={styles.choiceText}>Deny</Text>
            </Pressable>
          </View>
        )}
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
  if (widget === "question") {
    return (
      <QuestionWidget
        prompt={String(props.prompt ?? props.title ?? "Pick one")}
        helpText={typeof props.helpText === "string" ? props.helpText : ""}
        options={parseQuestionOptions(props.options)}
        allowCustom={props.allowCustom === true}
        selected={typeof props.selected === "string" ? props.selected : null}
        onPick={(pick) => {
          if (messageId && onQuestionPick) onQuestionPick(messageId, pick);
        }}
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

type QuestionOption = {
  label: string;
  value: string;
  description: string;
  style: "default" | "primary" | "danger";
};

/** Normalizes question options. Input: {label, value?, description?, style?}[]. Output: up to 6 choices. */
function parseQuestionOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    if (typeof item === "string") {
      const label = item.trim();
      return label ? [{ label, value: label, description: "", style: "default" as const }] : [];
    }
    if (!item || typeof item !== "object" || typeof (item as { label?: unknown }).label !== "string") {
      return [];
    }
    const row = item as { label: string; value?: unknown; description?: unknown; style?: unknown };
    const label = row.label.trim();
    if (!label) return [];
    const style: QuestionOption["style"] = row.style === "primary" || row.style === "danger" ? row.style : "default";
    const value = typeof row.value === "string" && row.value.trim() ? row.value.trim() : label;
    const description = typeof row.description === "string" ? row.description : "";
    return [{ label, value, description, style }];
  }).slice(0, 6);
}

/**
 * Compact single-choice card. Tap stays on the widget — no user chat bubble.
 */
function QuestionWidget({
  prompt,
  helpText,
  options,
  allowCustom,
  selected,
  onPick,
}: {
  prompt: string;
  helpText: string;
  options: QuestionOption[];
  allowCustom: boolean;
  selected: string | null;
  onPick?: (pick: { value: string; label: string }) => void;
}) {
  const [picked, setPicked] = useState(selected);
  const [custom, setCustom] = useState("");
  const done = picked !== null && picked.length > 0;

  function pick(value: string, label: string): void {
    if (done || !onPick || !value.trim()) return;
    setPicked(value.trim());
    onPick({ value: value.trim(), label: label.trim() || value.trim() });
  }

  return (
    <View style={styles.questionCard}>
      <Text style={styles.questionPrompt}>{prompt}</Text>
      {helpText ? <Text style={styles.questionHelp}>{helpText}</Text> : null}
      <View style={styles.questionOptions}>
        {options.map((option) => {
          const on = picked === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              disabled={done}
              onPress={() => pick(option.value, option.label)}
              style={[
                styles.questionBtn,
                option.style === "primary" ? styles.questionPrimary : null,
                option.style === "danger" ? styles.questionDanger : null,
                on ? styles.questionSelected : null,
                done && !on ? styles.questionDone : null,
              ]}
            >
              <Text
                style={[
                  styles.questionLabel,
                  option.style === "primary" || option.style === "danger" || on ? styles.questionLabelOn : null,
                ]}
                numberOfLines={1}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {allowCustom && !done ? (
        <View style={styles.secretRow}>
          <TextInput
            value={custom}
            onChangeText={setCustom}
            placeholder="Something else"
            placeholderTextColor={colors.muted}
            keyboardAppearance="dark"
            style={styles.questionCustom}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!custom.trim()}
            onPress={() => pick(custom, custom)}
            style={[styles.secretSave, custom.trim() ? styles.secretSaveReady : null]}
          >
            <Text style={[styles.secretSaveText, custom.trim() ? styles.secretSaveTextReady : null]}>OK</Text>
          </Pressable>
        </View>
      ) : null}
      {done ? <Text style={styles.questionPicked}>Selected</Text> : null}
    </View>
  );
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
      <View style={styles.secretStack}>
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
          style={[styles.secretSave, styles.secretSaveWide, ready ? styles.secretSaveReady : null]}
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
  mdBold: { fontWeight: "700", color: colors.text },
  richStack: { gap: 8 },
  mdTableHead: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  mdTableHeader: { width: 148, color: colors.text, fontSize: 13, fontWeight: "700", paddingVertical: 6, paddingRight: 10 },
  mdTableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#2C2C2E" },
  mdTableCell: { width: 148, color: colors.text, fontSize: 13, lineHeight: 18, paddingVertical: 6, paddingRight: 10 },
  mdCode: {
    fontFamily: "monospace",
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.control,
  },
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
  approvalStatus: { color: colors.muted, fontSize: 14, fontWeight: "600", marginTop: 2 },
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
  questionOptions: { gap: 6 },
  questionCard: { gap: 6, minWidth: 180, maxWidth: 280 },
  questionPrompt: { color: colors.text, fontSize: 15, fontWeight: "600", lineHeight: 20 },
  questionHelp: { color: colors.muted, fontSize: 12, lineHeight: 16 },
  questionBtn: {
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  questionPrimary: { backgroundColor: "#1d5c2e" },
  questionDanger: { backgroundColor: "#6e2b2b" },
  questionSelected: { borderWidth: 1, borderColor: colors.link },
  questionDone: { opacity: 0.4 },
  questionLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
  questionLabelOn: { color: "#fff" },
  questionCustom: {
    flex: 1,
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: 10,
    height: 36,
    paddingHorizontal: 10,
    fontSize: 14,
  },
  questionPicked: { color: colors.muted, fontSize: 12 },
  dismissed: { color: colors.muted, fontSize: 14 },
  tableHead: { flexDirection: "row", paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tableHeader: { color: colors.text, fontSize: 14, fontWeight: "700" },
  tableRow: { flexDirection: "row", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tableCell: { color: colors.text, fontSize: 14 },
  tableNote: { color: colors.text, fontSize: 16, lineHeight: 24, marginTop: 8 },
  secretRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  secretStack: { gap: 8 },
  secretInput: {
    alignSelf: "stretch",
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: 12,
    height: 48,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  secretSave: { height: 48, borderRadius: 24, backgroundColor: colors.control, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  secretSaveWide: { alignSelf: "stretch", borderRadius: 12 },
  secretSaveReady: { backgroundColor: colors.text },
  secretSaveText: { color: colors.muted, fontSize: 16, fontWeight: "600" },
  secretSaveTextReady: { color: colors.bg },
  secretFoot: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  secretFootText: { color: colors.muted, fontSize: 13, flex: 1 },
});
