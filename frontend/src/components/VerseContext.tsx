import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { api, type Language } from '../api';
import { setContextLanguage, setState, useStore, type State } from '../store';

/** "60.2:9-10" gives the keys its book and chapter background are stored under. */
export function scopesOf(canonicalKey: string) {
  const [book, rest = ''] = canonicalKey.split('.');
  const chapter = rest.split(':')[0];
  return { book: `book:${book}`, chapter: `chapter:${book}.${chapter}`, history: `history:${book}` };
}

/** "I Peter 2:9-10" gives "I Peter 2" and "I Peter". */
export function scopeNames(reference: string) {
  const chapter = reference.split(':')[0].trim();
  return { chapter, book: chapter.replace(/\s+\d+$/, '') };
}

/** Where each part's Tagalog wording is stored. */
export function tagalogItems(canonicalKey: string) {
  return { speaker: `speaker:${canonicalKey}`, verseNote: `note:${canonicalKey}`, ...scopesOf(canonicalKey) };
}

export const CONTEXT_LABELS = {
  en: {
    speaker: 'Speaker',
    verseNote: 'Verse note',
    chapter: 'Chapter context',
    book: 'Book context',
    history: 'Historical and political context',
    aiWarning: 'AI context, not scripture. Review before use.',
    aiNote: 'AI note, not scripture. Review before use',
    aiTag: '(AI, review before use)',
    reviewed: 'Reviewed by you.',
  },
  tl: {
    speaker: 'Nagsasalita',
    verseNote: 'Tala sa talata',
    chapter: 'Konteksto ng kabanata',
    book: 'Konteksto ng aklat',
    history: 'Kontekstong pangkasaysayan at pampulitika',
    aiWarning: 'Konteksto mula sa AI, hindi Kasulatan. Suriin bago gamitin.',
    aiNote: 'Tala mula sa AI, hindi Kasulatan. Suriin bago gamitin',
    aiTag: '(AI, suriin bago gamitin)',
    reviewed: 'Sinuri mo na.',
  },
} as const;

export interface VerseBackground {
  speaker: string;
  verseNote: string;
  chapter: string;
  book: string;
  history: string;
  /** True only when the user has reviewed every part that is shown, in the language shown. */
  reviewed: boolean;
  empty: boolean;
  /** Parts shown in English because they have no Tagalog yet. */
  untranslated: string[];
}

type ContextState = Pick<State, 'contexts' | 'scripture' | 'tagalog'>;

export function backgroundOf(s: ContextState, canonicalKey: string, language: Language = 'en'): VerseBackground {
  const verse = s.contexts[canonicalKey];
  const scopes = scopesOf(canonicalKey);
  const items = tagalogItems(canonicalKey);
  const untranslated: string[] = [];
  const pick = (item: string, english: string | undefined, englishReviewed: boolean) => {
    const translated = language === 'tl' ? s.tagalog[item] : undefined;
    if (translated) return { text: translated.text, reviewed: translated.reviewed };
    if (language === 'tl' && english) untranslated.push(item);
    return { text: english ?? '', reviewed: englishReviewed };
  };
  const scope = (name: string) => pick(name, s.scripture[name]?.context, s.scripture[name]?.reviewed ?? false);
  const parts = {
    speaker: pick(items.speaker, verse?.speaker, verse?.reviewed ?? false),
    verseNote: pick(items.verseNote, verse?.context, verse?.reviewed ?? false),
    chapter: scope(scopes.chapter),
    book: scope(scopes.book),
    history: scope(scopes.history),
  };
  const shown = Object.values(parts).filter((p) => p.text);
  return {
    speaker: parts.speaker.text,
    verseNote: parts.verseNote.text,
    chapter: parts.chapter.text,
    book: parts.book.text,
    history: parts.history.text,
    reviewed: shown.length > 0 && shown.every((p) => p.reviewed),
    empty: shown.length === 0,
    untranslated,
  };
}

/** Lines for a copied or exported lecture, labelled until the user has reviewed them. */
export function backgroundAsText(b: VerseBackground, language: Language = 'en') {
  const labels = CONTEXT_LABELS[language];
  const tag = b.reviewed ? '' : ` ${labels.aiTag}`;
  const line = (label: string, text: string) => (text ? [`${label}${tag}: ${text}`] : []);
  return [
    ...line(labels.speaker, b.speaker),
    ...line(labels.verseNote, b.verseNote),
    ...line(labels.chapter, b.chapter),
    ...line(labels.book, b.book),
    ...line(labels.history, b.history),
  ];
}

// The local model does one thing well at a time on a CPU, so all translation shares one line.
const inFlight = new Map<string, Promise<boolean>>();
let line: Promise<unknown> = Promise.resolve();

function translate(item: string) {
  const running = inFlight.get(item);
  if (running) return running;
  const job = line
    .then(() => api.translateContext(item))
    .then((r) => {
      setState({ tagalog: r.tagalog });
      return r.available;
    })
    .catch(() => false)
    .finally(() => inFlight.delete(item));
  line = job;
  inFlight.set(item, job);
  return job;
}

/** Fetches Tagalog for what is on screen. Nothing is translated until someone wants to read it. */
export function useTagalog(items: string[], active: boolean) {
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const wanted = items.join('|');
  useEffect(() => {
    if (!active || !wanted) return;
    let alive = true;
    setBusy(true);
    Promise.all(wanted.split('|').map(translate)).then((results) => {
      if (!alive) return;
      setBusy(false);
      setOffline(results.some((available) => !available));
    });
    return () => {
      alive = false;
    };
  }, [wanted, active]);
  return { busy: busy && !!wanted, offline };
}

/** Slides from left to right to change the language context is shown in. */
export function ContextLanguageSwitch({ language, onChange, testId = 'context-language' }: { language: Language; onChange: (l: Language) => void; testId?: string }) {
  const on = language === 'tl';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Show context in Tagalog"
      data-testid={testId}
      className="no-print tap inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1 text-xs text-muted max-lg:min-h-11"
      onClick={() => onChange(on ? 'en' : 'tl')}
    >
      <span className={on ? '' : 'font-semibold text-fg'}>English</span>
      <span className={`relative inline-block h-[18px] w-8 flex-none rounded-full border border-line transition-colors ${on ? 'bg-accent2' : 'bg-raised'}`}>
        <span className={`absolute top-px left-px size-3.5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${on ? 'translate-x-3.5' : ''}`} data-testid={`${testId}-thumb`} />
      </span>
      <span className={on ? 'font-semibold text-fg' : ''}>Tagalog</span>
    </button>
  );
}

/** The AI's reading of a verse, always labelled as such and kept apart from the text. */
export function ContextLines({ verseKey, reference, referenceTl, testId, active = true }: { verseKey: string; reference: string; referenceTl?: string; testId: string; active?: boolean }) {
  const contexts = useStore((s) => s.contexts);
  const scripture = useStore((s) => s.scripture);
  const tagalog = useStore((s) => s.tagalog);
  const language = useStore((s) => s.contextLanguage);
  const b = backgroundOf({ contexts, scripture, tagalog }, verseKey, language);
  const { busy, offline } = useTagalog(b.untranslated, active && language === 'tl');
  if (b.empty) return null;
  const labels = CONTEXT_LABELS[language];
  const names = scopeNames(language === 'tl' && referenceTl ? referenceTl : reference);
  const part = (id: string, label: string, text: string) => text && <span className="block" data-testid={`${testId}-${id}`}><span className="font-semibold">{label}: </span>{text}</span>;
  return (
    <span className="block" data-testid={testId}>
      <span className="font-semibold" data-testid={`${testId}-label`}>{b.reviewed ? labels.reviewed : labels.aiWarning}</span>
      {part('speaker', labels.speaker, b.speaker)}
      {part('note', labels.verseNote, b.verseNote)}
      {part('chapter', `${labels.chapter} (${names.chapter})`, b.chapter)}
      {part('book', `${labels.book} (${names.book})`, b.book)}
      {part('history', `${labels.history} (${names.book})`, b.history)}
      {language === 'tl' && b.untranslated.length > 0 && (
        <span className="no-print mt-1 flex items-center gap-1 text-muted" data-testid={`${testId}-translating`}>
          {busy ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Isinasalin sa computer na ito. Maaaring tumagal ito ng ilang minuto. Translating on this computer; this can take a few minutes.
            </>
          ) : offline ? (
            'Local AI is offline, so the parts above that have no Tagalog yet stay in English.'
          ) : (
            'The AI could not give a usable Tagalog version of the parts still in English. Use Review or correct to write your own.'
          )}
        </span>
      )}
    </span>
  );
}

function useTranslatedNote(note: string | undefined, active: boolean) {
  const [translated, setTranslated] = useState<{ note: string; text: string } | null>(null);
  useEffect(() => {
    if (!active || !note || translated?.note === note) return;
    let alive = true;
    const job = line.then(() => api.translateText(note)).catch(() => ({ available: false, text: null }));
    line = job;
    job.then((r) => {
      if (alive && r.text) setTranslated({ note, text: r.text });
    });
    return () => {
      alive = false;
    };
  }, [note, active, translated]);
  return translated && translated.note === note ? translated.text : null;
}

/**
 * Keeps context out of the way until it is wanted. It stays in the page while closed so that
 * a printed lecture still includes it.
 */
export function ContextPanel({ verseKey, reference, referenceTl, testId, note, children }: { verseKey: string; reference: string; referenceTl?: string; testId: string; note?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const language = useStore((s) => s.contextLanguage);
  const contexts = useStore((s) => s.contexts);
  const scripture = useStore((s) => s.scripture);
  const tagalog = useStore((s) => s.tagalog);
  const reviewed = backgroundOf({ contexts, scripture, tagalog }, verseKey, language);
  const noteTl = useTranslatedNote(note, open && language === 'tl');
  const labels = CONTEXT_LABELS[language];
  const hasContent = !reviewed.empty || !!note;
  return (
    <div className="my-1" data-testid={`${testId}-panel`} data-open={open}>
      <button
        type="button"
        className="no-print tap inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1 text-xs font-semibold text-accent2 hover:bg-raised max-lg:min-h-11"
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight size={14} className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        {open ? 'Hide details' : 'Show context and details'}
        {hasContent && <span className="font-normal text-muted">· {reviewed.reviewed && !note ? 'reviewed' : 'AI, review before use'}</span>}
      </button>
      <div className={`${open ? '' : 'hidden print:block'} mt-1 space-y-1 text-xs leading-relaxed text-accent2`}>
        <ContextLanguageSwitch language={language} onChange={setContextLanguage} />
        {note && (
          <p className="m-0" data-testid="ai-note">
            <span className="font-semibold">{labels.aiNote}: </span>
            {language === 'tl' && noteTl ? noteTl : note}
          </p>
        )}
        <ContextLines verseKey={verseKey} reference={reference} referenceTl={referenceTl} testId={testId} active={open} />
        {children}
      </div>
    </div>
  );
}

