export interface VerseTextPart {
  text: string;
  superscript: boolean;
}

/** Format printed verse markers without adding, removing, or rewriting any text. */
export function verseTextParts(text: string): VerseTextPart[] {
  const parts: VerseTextPart[] = [];
  // PDF extraction often joins a small raised number to the first word: 8Subalit.
  // A separated number is a marker only at the start of the text or a new line;
  // numbers in sentences (40 days, 12,000 people, etc.) keep their normal position.
  const markers = /(^|[\s"'“‘([{])([1-9]\d{0,2})(?=\p{L}|[ \t]+["'“‘([{]*\p{L})/gu;
  let end = 0;
  for (const match of text.matchAll(markers)) {
    const start = match.index + match[1].length;
    const after = text.slice(start + match[2].length);
    if (/^(?:st|nd|rd|th)(?!\p{L})/iu.test(after)) continue;
    if (!/^\p{L}/u.test(after)) {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      if (!/^[\s"'“‘([{]*$/u.test(text.slice(lineStart, start))) continue;
    }
    if (start > end) parts.push({ text: text.slice(end, start), superscript: false });
    parts.push({ text: match[2], superscript: true });
    end = start + match[2].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end), superscript: false });
  return parts;
}
