import { Feather, MaterialIcons } from "@expo/vector-icons";
import { colors } from "../theme/tokens";

/**
 * Draws one white icon used in the phone chrome.
 * Input: none.
 * Output: an 18-point glyph.
 */
export function IconSearch() {
  return <Feather name="search" size={18} color="#fff" />;
}

/** Draws a plus. Input: none. Output: a plus glyph. */
export function IconPlus() {
  return <Feather name="plus" size={18} color="#fff" />;
}

/** Draws a back chevron. Input: none. Output: a left chevron. */
export function IconBack() {
  return <Feather name="chevron-left" size={22} color="#fff" />;
}

/** Draws a desktop. Input: none. Output: a monitor glyph. */
export function IconMonitor() {
  return <Feather name="monitor" size={18} color="#fff" />;
}

/** Draws a microphone. Input: none. Output: a mic glyph. */
export function IconMic() {
  return <Feather name="mic" size={18} color="#fff" />;
}

/** Draws a voice waveform. Input: none. Output: a pulse glyph. */
export function IconWave() {
  return <Feather name="activity" size={18} color="#fff" />;
}

/** Draws a question mark. Input: none. Output: a help glyph. */
export function IconHelp() {
  return <Feather name="help-circle" size={18} color="#fff" />;
}

/** Draws an ellipsis. Input: none. Output: three dots. */
export function IconMore() {
  return <Feather name="more-horizontal" size={18} color="#fff" />;
}

/** Draws a clipboard. Input: none. Output: a clipboard glyph. */
export function IconClipboard() {
  return <Feather name="clipboard" size={18} color="#fff" />;
}

/** Draws a keyboard. Input: none. Output: a keyboard glyph. */
export function IconKeyboard() {
  return <MaterialIcons name="keyboard" size={20} color="#fff" />;
}

/** Draws a close mark. Input: none. Output: an X glyph. */
export function IconClose() {
  return <Feather name="x" size={18} color="#fff" />;
}

/** Draws a right chevron. Input: none. Output: a right chevron. */
export function IconChevron() {
  return <Feather name="chevron-right" size={18} color="#8E8E93" />;
}

/** Draws a check. Input: none. Output: a check glyph. */
export function IconCheck() {
  return <Feather name="check" size={18} color="#fff" />;
}

/** Draws a trash can. Input: none. Output: a trash glyph in red. */
export function IconTrash() {
  return <Feather name="trash-2" size={18} color="#FF453A" />;
}

/** Draws a reply arrow. Input: none. Output: a reply glyph. */
export function IconReply() {
  return <Feather name="corner-up-left" size={16} color="#8E8E93" />;
}

/** Draws a share tray with an up arrow. Input: none. Output: an iOS-style share glyph. */
export function IconShare() {
  return <Feather name="upload" size={20} color="#fff" />;
}

/** Draws a document with text lines. Input: none. Output: an instructions glyph. */
export function IconDoc() {
  return <Feather name="file-text" size={20} color="#8E8E93" />;
}

/** Draws a clock face. Input: none. Output: a green schedule glyph. */
export function IconClock() {
  return <Feather name="clock" size={20} color={colors.green} />;
}

/** Draws a shield badge. Input: none. Output: a secure-storage glyph. */
export function IconShield() {
  return <Feather name="shield" size={16} color="#8E8E93" />;
}
