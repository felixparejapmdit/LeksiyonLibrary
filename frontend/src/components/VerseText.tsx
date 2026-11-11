import { useMemo } from 'react';
import { verseTextParts } from '../verseText';

/** Shared scripture display, including search highlights and printed verse numbers. */
export function VerseText({ text, query = '' }: { text: string; query?: string }) {
  const parts = useMemo(() => verseTextParts(text), [text]);
  const highlights = useMemo(() => {
    const terms = query.trim().split(/\s+/).filter(Boolean).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return terms.length ? [...text.matchAll(new RegExp(terms.join('|'), 'gi'))].map((match) => ({ start: match.index, end: match.index + match[0].length })) : [];
  }, [text, query]);
  let offset = 0;
  return <>{parts.map((part, i) => {
    const content = [];
    let end = 0;
    for (const highlight of highlights) {
      if (highlight.end <= offset || highlight.start >= offset + part.text.length) continue;
      const start = Math.max(0, highlight.start - offset);
      const stop = Math.min(part.text.length, highlight.end - offset);
      if (start > end) content.push(part.text.slice(end, start));
      content.push(<mark key={start}>{part.text.slice(start, stop)}</mark>);
      end = stop;
    }
    if (end < part.text.length) content.push(part.text.slice(end));
    offset += part.text.length;
    return part.superscript ? <sup className="verse-number" key={i}>{content}</sup> : <span key={i}>{content}</span>;
  })}</>;
}
