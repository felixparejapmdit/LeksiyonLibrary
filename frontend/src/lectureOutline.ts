import type { Language, Verse } from './api';
import { backgroundAsText, backgroundOf, CONTEXT_LABELS } from './components/VerseContext';

/** The words a lesson PDF prints for each part, in either language. */
export const OUTLINE_WORDS = {
  en: { issue: 'Issue', objectives: 'Objectives', intro: 'Introduction', other: 'Other verses' },
  tl: { issue: 'Isyu', objectives: 'Mga Layunin', intro: 'Pasimula', other: 'Iba pang talata' },
} as const;

const ROMAN: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
const roman = (n: number) => ROMAN.reduce((out, [value, digits]) => {
  while (n >= value) {
    out += digits;
    n -= value;
  }
  return out;
}, '');

/** A., B., C. for the verses of a part, as the lessons letter their points. */
export const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`);

export interface OutlinePart {
  /** The objective this part teaches; empty for verses chosen for none. */
  objective: string;
  /** "Introduction", "I.", "II." and so on, or "Other verses"; empty when a lecture has no objectives. */
  label: string;
  ids: string[];
}

/**
 * The parts of a lecture, built as a lesson is: its first objective is taught in the
 * Introduction (Pasimula), its second in part I., its third in II., and so on. Verses
 * stay in the order they were arranged in, within their part.
 */
export function outlineParts(objectives: string[], picked: string[], objectiveOf: (id: string) => string, language: Language): OutlinePart[] {
  const words = OUTLINE_WORDS[language];
  const order = objectives.map((o) => o.trim()).filter(Boolean);
  // A verse kept from an objective since reworded still has a part of its own.
  for (const id of picked) {
    const o = objectiveOf(id).trim();
    if (o && !order.includes(o)) order.push(o);
  }
  const parts: OutlinePart[] = order.map((objective, i) => ({ objective, label: i === 0 ? words.intro : `${roman(i)}.`, ids: picked.filter((id) => objectiveOf(id).trim() === objective) }));
  const loose = picked.filter((id) => !objectiveOf(id).trim());
  if (loose.length) parts.push({ objective: '', label: order.length ? words.other : '', ids: loose });
  return parts;
}

export type ContextSource = Parameters<typeof backgroundOf>[0];

/** The lines of AI context printed under a verse, with the warning while it is unreviewed. */
export function contextLines(state: ContextSource, verse: Verse, language: Language): { warning: string | null; lines: string[] } {
  const b = backgroundOf(state, verse.canonical_key, language);
  const lines = backgroundAsText(b, language).map((l) => l.replace(` ${CONTEXT_LABELS[language].aiTag}`, ''));
  return { warning: lines.length && !b.reviewed ? CONTEXT_LABELS[language].aiWarning : null, lines };
}

export interface Outline {
  title: string;
  issue: string;
  objectives: string[];
  parts: OutlinePart[];
}

/** The outline as plain text, for pasting anywhere. */
export function outlineText(o: Outline, byId: Map<string, Verse>, language: Language, context: ContextSource | null): string {
  const words = OUTLINE_WORDS[language];
  const out = [o.title.trim(), ''];
  if (o.issue.trim()) out.push(`${words.issue}:`, o.issue.trim(), '');
  if (o.objectives.length) out.push(`${words.objectives}:`, ...o.objectives.map((x, i) => `${i + 1}. ${x}`), '');
  for (const part of o.parts) {
    if (part.label) out.push(part.objective ? `${part.label}${part.label.endsWith('.') ? '' : ':'} ${part.objective.toUpperCase()}` : part.label.toUpperCase(), '');
    part.ids.forEach((id, i) => {
      const v = byId.get(id);
      if (!v) return;
      out.push(`${letter(i)}. ${v.ref_printed}${v.version ? ` (${v.version})` : ''}`, v.text);
      // Pasted text keeps the AI label on every line, since it can end up anywhere.
      if (context) out.push(...backgroundAsText(backgroundOf(context, v.canonical_key, language), language));
      out.push('');
    });
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
