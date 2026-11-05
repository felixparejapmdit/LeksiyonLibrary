import { useStore, type State } from '../store';

/** "60.2:9-10" gives the keys its book and chapter background are stored under. */
export function scopesOf(canonicalKey: string) {
  const [book, rest = ''] = canonicalKey.split('.');
  const chapter = rest.split(':')[0];
  return { book: `book:${book}`, chapter: `chapter:${book}.${chapter}` };
}

/** "I Peter 2:9-10" gives "I Peter 2" and "I Peter". */
export function scopeNames(reference: string) {
  const chapter = reference.split(':')[0].trim();
  return { chapter, book: chapter.replace(/\s+\d+$/, '') };
}

export interface VerseBackground {
  speaker: string;
  verseNote: string;
  chapter: string;
  book: string;
  /** True only when the user has reviewed every part that is shown. */
  reviewed: boolean;
  empty: boolean;
}

export function backgroundOf(s: Pick<State, 'contexts' | 'scripture'>, canonicalKey: string): VerseBackground {
  const verse = s.contexts[canonicalKey];
  const scopes = scopesOf(canonicalKey);
  const chapter = s.scripture[scopes.chapter];
  const book = s.scripture[scopes.book];
  const present = [verse, chapter, book].filter((x) => x !== undefined);
  return {
    speaker: verse?.speaker ?? '',
    verseNote: verse?.context ?? '',
    chapter: chapter?.context ?? '',
    book: book?.context ?? '',
    reviewed: present.length > 0 && present.every((x) => x.reviewed),
    empty: present.length === 0,
  };
}

/** Lines for a copied or exported lecture, labelled until the user has reviewed them. */
export function backgroundAsText(b: VerseBackground) {
  const tag = b.reviewed ? '' : ' (AI, review before use)';
  return [
    ...(b.speaker ? [`Speaker${tag}: ${b.speaker}`] : []),
    ...(b.verseNote ? [`Verse note${tag}: ${b.verseNote}`] : []),
    ...(b.chapter ? [`Chapter context${tag}: ${b.chapter}`] : []),
    ...(b.book ? [`Book context${tag}: ${b.book}`] : []),
  ];
}

/** The AI's reading of a verse, always labelled as such and kept apart from the text. */
export function ContextLines({ verseKey, reference, testId }: { verseKey: string; reference: string; testId: string }) {
  const contexts = useStore((s) => s.contexts);
  const scripture = useStore((s) => s.scripture);
  const b = backgroundOf({ contexts, scripture }, verseKey);
  if (b.empty) return null;
  const names = scopeNames(reference);
  return (
    <span data-testid={testId}>
      <span className="font-semibold" data-testid={`${testId}-label`}>{b.reviewed ? 'Reviewed by you.' : 'AI context, not scripture. Review before use.'}</span>
      {b.speaker && <span className="block" data-testid={`${testId}-speaker`}><span className="font-semibold">Speaker: </span>{b.speaker}</span>}
      {b.verseNote && <span className="block" data-testid={`${testId}-note`}><span className="font-semibold">Verse note: </span>{b.verseNote}</span>}
      {b.chapter && <span className="block" data-testid={`${testId}-chapter`}><span className="font-semibold">Chapter context ({names.chapter}): </span>{b.chapter}</span>}
      {b.book && <span className="block" data-testid={`${testId}-book`}><span className="font-semibold">Book context ({names.book}): </span>{b.book}</span>}
    </span>
  );
}
