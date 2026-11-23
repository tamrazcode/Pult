/**
 * Composer markdown editing helpers. Plain textarea + pure functions: the
 * browser keeps selection/undo when possible, and nothing here sends a message.
 */
export interface MarkdownEditResult {
  nextText: string;
  selectionStart: number;
  selectionEnd: number;
  /** Range passed to execCommand/setRangeText so native undo stays intact. */
  replaceStart: number;
  replaceEnd: number;
  replacement: string;
}

/** Odd number of ``` lines before the caret means we are inside a fence. */
export function isInsideCodeFence(text: string, caret: number): boolean {
  let fences = 0;
  for (const line of text.slice(0, caret).split("\n")) {
    if (line.trimStart().startsWith("```")) fences += 1;
  }
  return fences % 2 === 1;
}

function lineBounds(text: string, caret: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const next = text.indexOf("\n", caret);
  return { start, end: next === -1 ? text.length : next };
}

function edit(
  text: string,
  replaceStart: number,
  replaceEnd: number,
  replacement: string,
  caret: number,
): MarkdownEditResult {
  return {
    nextText: text.slice(0, replaceStart) + replacement + text.slice(replaceEnd),
    selectionStart: caret,
    selectionEnd: caret,
    replaceStart,
    replaceEnd,
    replacement,
  };
}

/** `1)` + space becomes `1. `; other prefixes are already valid markdown. */
export function handleMarkdownSpace(
  text: string,
  start: number,
  end: number,
): MarkdownEditResult | null {
  if (start !== end || isInsideCodeFence(text, start)) return null;
  const { start: lineStart } = lineBounds(text, start);
  const before = text.slice(lineStart, start);
  const match = /^(\s*)([1-9]\d*)\)$/.exec(before);
  if (!match) return null;
  const replacement = `${match[1]}${match[2]}. `;
  return edit(text, lineStart, start, replacement, lineStart + replacement.length);
}

/**
 * Enter that does not send: continue bullets/numbers/quotes/checkboxes, and
 * drop the marker when the current item is empty. Headings end on Enter.
 */
export function handleMarkdownNewline(
  text: string,
  start: number,
  end: number,
): MarkdownEditResult | null {
  if (start !== end || isInsideCodeFence(text, start)) return null;
  const { start: lineStart, end: lineEnd } = lineBounds(text, start);
  const line = text.slice(lineStart, lineEnd);
  const caret = start - lineStart;
  const prefix = line.slice(0, caret);
  const suffix = line.slice(caret);

  const finish = () => edit(text, lineStart, lineEnd, "", lineStart);

  const checkbox = /^(\s*)([-*])\s+\[(?: |x|X)\]\s+(.*)$/.exec(prefix);
  if (checkbox) {
    if (checkbox[3].trim() === "" && suffix.trim() === "") return finish();
    const marker = `${checkbox[1]}${checkbox[2]} [ ] `;
    return edit(text, start, end, `\n${marker}`, start + 1 + marker.length);
  }
  const bullet = /^(\s*)([-*])\s+(.*)$/.exec(prefix);
  if (bullet) {
    if (bullet[3].trim() === "" && suffix.trim() === "") return finish();
    const marker = `${bullet[1]}${bullet[2]} `;
    return edit(text, start, end, `\n${marker}`, start + 1 + marker.length);
  }
  const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(prefix);
  if (numbered) {
    if (numbered[3].trim() === "" && suffix.trim() === "") return finish();
    const marker = `${numbered[1]}${Number(numbered[2]) + 1}. `;
    return edit(text, start, end, `\n${marker}`, start + 1 + marker.length);
  }
  const quote = /^(\s*)>\s+(.*)$/.exec(prefix);
  if (quote) {
    if (quote[2].trim() === "" && suffix.trim() === "") return finish();
    const marker = `${quote[1]}> `;
    return edit(text, start, end, `\n${marker}`, start + 1 + marker.length);
  }
  if (/^(\s*)#{1,6}\s+/.test(prefix)) return null;
  return null;
}

/** Backspace right after a marker: outdent by 2 spaces, else drop the marker. */
export function handleMarkdownBackspace(
  text: string,
  start: number,
  end: number,
): MarkdownEditResult | null {
  if (start !== end || isInsideCodeFence(text, start)) return null;
  const { start: lineStart } = lineBounds(text, start);
  const before = text.slice(lineStart, start);
  const match = /^(\s*)((?:[-*] \[(?: |x|X)\]|[-*>]|#{1,6}|\d+\.)) $/.exec(before);
  if (!match) return null;
  const indent = match[1];
  if (indent.length >= 2) {
    const replacement = `${indent.slice(2)}${match[2]} `;
    return edit(text, lineStart, start, replacement, lineStart + replacement.length);
  }
  return edit(text, lineStart, start, "", lineStart);
}

/** Apply an edit through execCommand so Chromium keeps its undo stack. */
export function applyTextareaEdit(
  el: HTMLTextAreaElement,
  result: MarkdownEditResult,
  setValue: (value: string) => void,
): void {
  el.focus();
  el.setSelectionRange(result.replaceStart, result.replaceEnd);
  let applied: boolean;
  try {
    applied = document.execCommand?.("insertText", false, result.replacement) === true;
  } catch {
    applied = false;
  }
  if (!applied || el.value !== result.nextText) {
    setValue(result.nextText);
    requestAnimationFrame(() => el.setSelectionRange(result.selectionStart, result.selectionEnd));
    return;
  }
  el.setSelectionRange(result.selectionStart, result.selectionEnd);
}
