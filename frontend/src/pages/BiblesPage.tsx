import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, BookMarked, BookText, Check, ChevronDown, ChevronLeft, ChevronRight, Columns2, Copy, FileSearch, FileSpreadsheet, FileText, LayoutList, ListChecks, Lock, Loader2, PencilLine, Search, ShieldAlert, Sparkles, Table2, X } from 'lucide-react';
import { api, type Verse } from '../api';
import { VerseCorrectionDialog } from '../components/Overlays';
import { PAGE, PageHeader } from '../components/PageHeader';
import { VerseText } from '../components/VerseText';
import { scopeNames } from '../components/VerseContext';
import { openReview } from './ReviewPage';
import { matchesSearch } from '../search';
import { documentLabel } from '../documents';
import { askConfirm, derived, errorText, getState, libraryOf, navigate, resetFilters, selectLesson, setState, toast, useStore, verseGroups, type Library } from '../store';

function replaceVerse(v: Verse) {
  setState({ verses: getState().verses.map((x) => (x.id === v.id ? v : x)) });
}

export async function copyVerse(v: Verse) {
  const text = `${v.ref_printed}${v.version ? ` (${v.version})` : ''}\n${v.text}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Verse copied');
  } catch {
    toast('Your browser blocked copying. Select the text instead.', 'error');
  }
}

/** Where a verse came from: an imported Excel file or an uploaded lesson document. */
type Origin = 'import' | 'pdf';
const originOf = (v: Verse): Origin => (v.import_source ? 'import' : 'pdf');

/** Says plainly whether a verse was imported or read from an uploaded document, and from which. */
function OriginBadge({ verse, compact }: { verse: Verse; compact?: boolean }) {
  const source = verse.sources[0];
  const lesson = useStore((s) => (source ? s.lessons.find((l) => l.id === source.lesson_id) : undefined));
  if (originOf(verse) === 'import') {
    return (
      <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-ok/50 bg-ok/10 px-1.5 font-medium text-ok" data-testid="verse-origin" data-origin="import" title={`Imported from ${verse.import_source}`}>
        <FileSpreadsheet size={12} className="flex-none" /> <span className="truncate">{compact ? 'Excel' : 'Imported from Excel'}</span>
      </span>
    );
  }
  const format = lesson ? documentLabel(lesson) : 'document';
  const kind = `${source?.pastoral ? 'Pastoral visit' : 'Lesson'} ${format}`;
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-pv/50 bg-pv/10 px-1.5 font-medium text-pv" data-testid="verse-origin" data-origin="pdf" data-format={format.toLowerCase()} title={lesson ? `Read from the uploaded ${format} ${lesson.title}, page ${source?.page}` : 'Read from an uploaded document'}>
      <FileText size={12} className="flex-none" /> <span className="truncate">{compact ? format : `From ${kind.charAt(0).toLowerCase()}${kind.slice(1)}`}</span>
    </span>
  );
}

const VerseCard = memo(function VerseCard({ verse, query, alone }: { verse: Verse; query: string; alone: boolean }) {
  const [correcting, setCorrecting] = useState(false);
  const verified = verse.status === 'verified';
  const source = verse.sources[0];
  const lessonTitle = useStore((s) => (source ? s.lessons.find((l) => l.id === source.lesson_id)?.title : undefined));
  return (
    <div className={`flex h-full flex-col ${alone ? '' : 'rounded-md border border-line p-2.5'}`} data-testid="verse-card" data-verse-id={verse.id} data-language={verse.language} data-status={verse.status} data-origin={originOf(verse)}>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <OriginBadge verse={verse} />
        <span className="rounded border border-line px-1 font-semibold">{verse.language === 'tl' ? 'Tagalog' : 'English'}</span>
        {verse.version && <span className="rounded border border-line px-1 text-muted" data-testid="verse-version">{verse.version}</span>}
        {/* The heading already gives the reference, unless this record prints it differently. */}
        {verse.ref_printed !== verse.ref_en && <span className="font-medium" data-testid="verse-ref">{verse.ref_printed}</span>}
        {verified ? (
          <span className="flex items-center gap-1 text-ok" data-testid="verse-verified"><Lock size={12} /> Verified, locked</span>
        ) : (
          <span className="flex items-center gap-1 text-warn" data-testid="verse-unverified"><ShieldAlert size={12} /> {verse.import_source ? 'Unverified import' : 'Unverified scan'}</span>
        )}
      </div>
      {verse.ref_note && !verified && <p className="m-0 mb-1.5 text-xs text-warn" data-testid="verse-ref-note">{verse.ref_note}</p>}
      <p className="m-0 flex-1 text-[14px] leading-relaxed whitespace-pre-wrap" data-testid="verse-text">
        {verse.text ? <VerseText text={verse.text} query={query} /> : <span className="text-muted">Reference only. No text was printed in this lesson.</span>}
      </p>
      {verse.sources.some((s) => s.pastoral) && (
        <div className="mt-2 space-y-0.5 text-xs text-muted" data-testid="verse-usage">
          {verse.sources.filter((s) => s.pastoral).map((s) => (
            <p className="m-0" key={s.lesson_id} data-testid="verse-usage-date">Used in pastoral visit: {s.lesson_date ?? 'No date'} · page {s.page}</p>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {verse.import_source && <span className="mr-auto min-w-0 truncate text-xs text-muted" data-testid="verse-import-source">From {verse.import_source}</span>}
        {!verse.import_source && lessonTitle && <span className="mr-auto min-w-0 truncate text-xs text-muted" data-testid="verse-pdf-source" title={lessonTitle}>From {lessonTitle}</span>}
        <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="verse-copy" disabled={!verse.text} onClick={() => copyVerse(verse)}>
          <Copy size={13} /> Copy
        </button>
        {source && (
          <button
            className="btn !min-h-8 max-lg:!min-h-11"
            data-testid="verse-source"
            onClick={() => {
              resetFilters();
              selectLesson(source.lesson_id, source.page);
              setState({ viewerOpen: true });
              navigate('/');
            }}
          >
            <FileSearch size={13} /> Source p.{source.page}
          </button>
        )}
        {!verified && (
          <>
            <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="verse-correct" onClick={() => setCorrecting(true)}>
              <PencilLine size={13} /> Correct
            </button>
            <button
              className="btn !min-h-8 max-lg:!min-h-11"
              data-testid="verse-verify"
              disabled={!verse.text}
              onClick={() =>
                askConfirm({
                  title: 'Mark this verse as verified?',
                  body: `Confirm that the reference ${verse.ref_printed} and its text match ${verse.import_source ? 'the original' : 'the printed page'} exactly. Once verified it can never be edited, by you or by the AI.`,
                  confirmLabel: 'Verify and lock',
                  onConfirm: async () => {
                    replaceVerse(await api.verifyVerse(verse.id));
                    toast('Verse verified and locked');
                  },
                })
              }
            >
              <Check size={13} /> Verify
            </button>
          </>
        )}
      </div>
      {correcting && (
        <VerseCorrectionDialog
          text={verse.text}
          raw={verse.ocr_raw}
          reference={verse.ref_printed}
          onClose={() => setCorrecting(false)}
          onSave={async (patch) => {
            replaceVerse(await api.correctVerse(verse.id, patch));
            setCorrecting(false);
            toast('Correction saved');
          }}
        />
      )}
    </div>
  );
});

const PAGE_SIZES = [10, 25, 50, 100];
type Group = ReturnType<typeof verseGroups>[number];

type Layout = 'cards' | 'table' | 'parallel';

const LAYOUTS: { id: Layout; label: string; icon: typeof Table2 }[] = [
  { id: 'cards', label: 'Cards', icon: LayoutList },
  { id: 'table', label: 'Table', icon: Table2 },
  { id: 'parallel', label: 'Parallel', icon: Columns2 },
];

/** Only the choice of view is remembered between visits, never any verse. */
function storedLayout(): Layout {
  try {
    const saved = localStorage.getItem('lv.biblesLayout');
    return saved === 'table' || saved === 'parallel' ? saved : 'cards';
  } catch {
    return 'cards';
  }
}

function rememberLayout(layout: Layout) {
  try {
    localStorage.setItem('lv.biblesLayout', layout);
  } catch {
    /* private mode: it still applies for this session */
  }
}

interface View {
  layout: Layout;
  /** What each side of the parallel view shows: a language as lang:tl, or a translation's code. */
  left: string;
  right: string;
  /** Parallel view only: leave out references that one side has nothing for. */
  bothSides: boolean;
  query: string;
  language: 'all' | 'en' | 'tl';
  status: 'all' | 'verified' | 'unverified';
  origin: 'all' | Origin;
  translation: string;
  book: number | 'all';
  page: number;
  pageSize: number;
}

const NO_FILTERS = { query: '', language: 'all', status: 'all', origin: 'all', translation: 'all', book: 'all' } as const;

// Kept while the app is open, so coming back to either library finds it as it was left.
const startView = (): View => ({ ...NO_FILTERS, layout: storedLayout(), left: 'lang:en', right: 'lang:tl', bothSides: false, page: 1, pageSize: 25 });
const savedViews: Record<Library, View> = { verse: startView(), lesson: startView() };
// The caches below live in memory only and go when the app closes. Verses are sensitive, so
// none of this may be written to the disk or the browser's cache.
const searchText = new WeakMap<Verse, string>();
function searchTextOf(v: Verse) {
  let text = searchText.get(v);
  if (text === undefined) {
    text = `${v.ref_en} ${v.ref_tl} ${v.ref_printed} ${v.version} ${v.text}`.toLowerCase();
    searchText.set(v, text);
  }
  return text;
}

const byReference = new Intl.Collator(undefined, { numeric: true });

/** Page numbers around the current one: 1 … 4 5 6 … 28. */
function pageList(page: number, pages: number): (number | 'gap')[] {
  const wanted = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const sorted = [...wanted].sort((a, b) => a - b);
  return sorted.flatMap((n, i) => (i > 0 && n - sorted[i - 1] > 1 ? (['gap', n] as const) : [n]));
}

function Pagination({ page, pages, onPage, position = 'bottom' }: { page: number; pages: number; onPage: (n: number) => void; position?: 'top' | 'bottom' }) {
  if (pages <= 1) return null;
  const prefix = position === 'top' ? 'bibles-top-page' : 'bibles-page';
  return (
    <nav className="flex flex-wrap items-center justify-center gap-1" aria-label={`Pages at ${position}`} data-testid={position === 'top' ? 'bibles-pagination-top' : 'bibles-pagination'}>
      <button className="btn !min-h-8 max-lg:!min-h-11" aria-label="Previous page" data-testid={`${prefix}-prev`} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft size={14} /> Previous
      </button>
      {pageList(page, pages).map((n, i) =>
        n === 'gap' ? (
          <span key={`gap-${i}`} className="px-1 text-xs text-muted">…</span>
        ) : (
          <button
            key={n}
            className={`btn !min-h-8 min-w-8 justify-center tabular-nums max-lg:!min-h-11 max-lg:min-w-11 ${n === page ? 'border-accent2! font-semibold' : ''}`}
            aria-label={`Page ${n}`}
            aria-current={n === page ? 'page' : undefined}
            data-testid={`${prefix}-number`}
            onClick={() => onPage(n)}
          >
            {n}
          </button>
        ),
      )}
      <button className="btn !min-h-8 max-lg:!min-h-11" aria-label="Next page" data-testid={`${prefix}-next`} disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next <ChevronRight size={14} />
      </button>
    </nav>
  );
}

/** One reference. Extra translations fold away so a page stays quick to scan. */
const ReferenceGroup = memo(function ReferenceGroup({ group, query }: { group: Group; query: string }) {
  const [expanded, setExpanded] = useState(false);
  const first = group.items[0];
  const leading = useMemo(() => {
    const seen = new Set<string>();
    return group.items.filter((v) => !seen.has(v.language) && !!seen.add(v.language));
  }, [group.items]);
  // A search shows every wording that matched, since one of them is what is being looked for.
  const showAll = expanded || !!query.trim() || group.items.length <= 2;
  const shown = showAll ? group.items : leading;
  const hidden = group.items.length - shown.length;
  const versions = [...new Set(group.items.map((v) => v.version).filter(Boolean))];
  return (
    <li className="rounded-lg border border-line bg-panel p-3" data-testid="verse-group" data-key={group.key}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="m-0 text-[14px] font-semibold" data-testid="verse-group-title">
          {first.ref_en}
          {first.ref_tl !== first.ref_en && <span className="font-normal text-muted"> · {first.ref_tl}</span>}
        </h2>
        {group.items.length > 1 && (
          <span className="text-xs text-muted" data-testid="verse-group-count">
            {group.items.length} verses{versions.length > 0 ? ` · ${versions.slice(0, 4).join(', ')}${versions.length > 4 ? ` and ${versions.length - 4} more` : ''}` : ''}
          </span>
        )}
      </div>
      <div className={`grid grid-cols-1 gap-2 ${shown.length > 1 ? 'md:grid-cols-2' : ''}`}>
        {shown.map((v) => (
          <VerseCard key={v.id} verse={v} query={query} alone={shown.length === 1} />
        ))}
      </div>
      {hidden > 0 && (
        <button className="btn mt-2 !min-h-8 max-lg:!min-h-11" data-testid="verse-group-more" aria-expanded={false} onClick={() => setExpanded(true)}>
          <ChevronDown size={14} /> Show {hidden} more
        </button>
      )}
    </li>
  );
});

/** The parts of a reference, as the columns of the sheet it may have come from. */
function referenceParts(v: Verse) {
  const [chapter = '', verse = ''] = (v.canonical_key.split('.')[1] ?? '').split(':');
  const part = v.ref_printed.startsWith(v.ref_en) ? v.ref_printed.slice(v.ref_en.length) : '';
  return { book: scopeNames(v.ref_en).book, chapter, verse: `${verse}${part}` };
}

function StatusMark({ verse }: { verse: Verse }) {
  return verse.status === 'verified' ? (
    <span className="inline-flex items-center gap-1 text-ok" data-testid="table-status"><Lock size={12} /> Verified</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-warn" data-testid="table-status"><ShieldAlert size={12} /> Unverified</span>
  );
}

/** One verse on one line, opening to the full card with its actions. */
const TableRow = memo(function TableRow({ verse, query }: { verse: Verse; query: string }) {
  const [open, setOpen] = useState(false);
  const { book, chapter, verse: number } = referenceParts(verse);
  const cell = 'border-b border-line px-2 py-1 align-top whitespace-nowrap';
  return (
    <>
      <tr className="hover:bg-raised/60" data-testid="table-row" data-verse-id={verse.id}>
        <td className={cell}>
          <button className="icon-btn !h-6 !w-6 max-lg:!h-11 max-lg:!w-11" aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'} ${verse.ref_printed} ${verse.version}`} data-testid="table-row-toggle" onClick={() => setOpen(!open)}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        </td>
        <td className={cell} data-testid="table-origin"><OriginBadge verse={verse} compact /></td>
        <td className={cell} data-testid="table-translation">{verse.version}</td>
        <td className={cell} data-testid="table-book">{book}</td>
        <td className={`${cell} tabular-nums`} data-testid="table-chapter">{chapter}</td>
        <td className={`${cell} tabular-nums`} data-testid="table-verse">{number}</td>
        <td className={`${cell} w-full max-w-0 truncate`} data-testid="table-text" title={verse.text}>
          {verse.text ? <VerseText text={verse.text} query={query} /> : <span className="text-muted">Reference only</span>}
        </td>
        <td className={cell} data-testid="table-language">{verse.language === 'tl' ? 'Tagalog' : 'English'}</td>
        <td className={cell}><StatusMark verse={verse} /></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} className="border-b border-line bg-panel p-3" data-testid="table-row-detail">
            <VerseCard verse={verse} query={query} alone />
          </td>
        </tr>
      )}
    </>
  );
});

/** Spreadsheet style: every verse on its own line, in the same columns as an imported sheet. */
function VerseTable({ rows, query }: { rows: Verse[]; query: string }) {
  const heading = 'border-b border-line px-2 py-1.5 text-left font-semibold whitespace-nowrap';
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-bg" data-testid="bibles-table">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-panel">
          <tr>
            <th className={heading}><span className="sr-only">Open</span></th>
            <th className={heading}>Source</th>
            <th className={heading}>Translation</th>
            <th className={heading}>Book</th>
            <th className={heading}>Chapter</th>
            <th className={heading}>Verse</th>
            <th className={heading}>Content</th>
            <th className={heading}>Language</th>
            <th className={heading}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => <TableRow key={v.id} verse={v} query={query} />)}
        </tbody>
      </table>
    </div>
  );
}

const sideLabel = (side: string) => (side === 'lang:tl' ? 'Tagalog' : side === 'lang:en' ? 'English' : side);
const onSide = (v: Verse, side: string) => (side.startsWith('lang:') ? v.language === side.slice(5) : v.version === side);

function ParallelSide({ verses, side, query, testId }: { verses: Verse[]; side: string; query: string; testId: string }) {
  return (
    <div className="min-w-0 space-y-2 p-2.5" data-testid={testId}>
      {verses.length === 0 && <p className="m-0 text-[13px] text-muted" data-testid="parallel-empty">No {sideLabel(side)} for this verse.</p>}
      {verses.map((v) => (
        <div key={v.id} data-testid="parallel-verse" data-verse-id={v.id}>
          <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-xs">
            <OriginBadge verse={v} compact />
            {v.version && <span className="rounded border border-line px-1 text-muted">{v.version}</span>}
            <StatusMark verse={v} />
            <button className="icon-btn ml-auto !h-6 !w-6 max-lg:!h-11 max-lg:!w-11" aria-label={`Copy ${v.ref_printed} ${v.version}`} data-testid="parallel-copy" disabled={!v.text} onClick={() => copyVerse(v)}><Copy size={12} /></button>
          </div>
          <p className="m-0 text-[14px] leading-relaxed whitespace-pre-wrap" data-testid="parallel-text">
            {v.text ? <VerseText text={v.text} query={query} /> : <span className="text-muted">Reference only.</span>}
          </p>
        </div>
      ))}
    </div>
  );
}

/** One library's verses, kept between visits while the verses are unchanged. */
const libraryVerses = (all: Verse[], library: Library) => derived(all, `library:${library}`, () => all.filter((v) => libraryOf(v) === library));

/** Its references in Bible order, kept the same way. */
const sortedGroups = (all: Verse[], library: Library) =>
  derived(all, `sorted:${library}`, () => verseGroups(libraryVerses(all, library)).sort((a, b) => a.book - b.book || byReference.compare(a.items[0].ref_en, b.items[0].ref_en)));

/** Prepares both libraries while the app is idle, so even the first visit opens at once. */
export function warmLibraries(all: Verse[]) {
  for (const library of ['verse', 'lesson'] as const) sortedGroups(all, library);
}

/**
 * One library's verses. The Verse Library holds verses read from pastoral visits and imported from sheets; the
 * Lesson Library's verses are the ones read from lesson PDFs.
 */
export function BiblesPage({ library }: { library: Library }) {
  const all = useStore((s) => s.verses);
  const verses = useMemo(() => libraryVerses(all, library), [all, library]);
  const rowsToFix = useStore((s) => (library === 'verse' ? s.rowsToFix.length : 0));
  const [view, setViewState] = useState<View>(savedViews[library]);
  const { layout, left, right, bothSides, query, language, status, origin, translation, book, pageSize } = view;
  const parallel = layout === 'parallel';
  const setView = (patch: Partial<View>) => setViewState((v) => ({ ...v, page: 1, ...patch }));
  useEffect(() => {
    savedViews[library] = view;
  }, [view, library]);
  // Typing stays instant: the list catches up just after, rather than holding up each key.
  const deferredQuery = useDeferredValue(query);
  const [meaningKeys, setMeaningKeys] = useState<string[] | null>(null);
  const [meaningBusy, setMeaningBusy] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const targetId = useStore((s) => s.verseTargetId);
  useEffect(() => {
    const verse = verses.find((v) => v.id === targetId);
    if (!verse) return;
    setMeaningKeys(null);
    setViewState((current) => ({ ...current, ...NO_FILTERS, layout: 'cards', query: verse.ref_en, language: verse.language, translation: verse.version || 'all', page: 1 }));
    setState({ verseTargetId: null });
    top.current?.scrollIntoView({ block: 'start' });
  }, [targetId, verses]);

  const findByMeaning = async () => {
    setMeaningBusy(true);
    try {
      const res = await api.searchMeaning(query);
      if (res.available) {
        setMeaningKeys(res.keys);
        setView({});
      } else toast('Search by meaning needs the local AI model. Searching by words still works.', 'error');
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setMeaningBusy(false);
  };

  const stats = useMemo(() => ({ verified: verses.filter((v) => v.status === 'verified').length, total: verses.length, imported: verses.filter((v) => originOf(v) === 'import').length }), [verses]);
  const translations = useMemo(() => [...new Set(verses.map((v) => v.version).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [verses]);
  const books = useMemo(() => {
    const names = new Map<number, string>();
    for (const v of verses) if (!names.has(v.book_id)) names.set(v.book_id, scopeNames(v.ref_en).book);
    return [...names.entries()].sort((a, b) => a[0] - b[0]);
  }, [verses]);

  // Sorted once for each change to the library, not again for every keystroke or filter.
  const sorted = useMemo(() => sortedGroups(all, library), [all, library]);

  const groups = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const keep = (v: Verse) =>
      // In the parallel view, the two sides choose the language and translation instead.
      (parallel || language === 'all' || v.language === language) &&
      (status === 'all' || v.status === status) &&
      (origin === 'all' || originOf(v) === origin) &&
      (parallel || translation === 'all' || v.version === translation) &&
      (book === 'all' || v.book_id === book) &&
      (meaningKeys !== null || !q || matchesSearch(searchTextOf(v), q));
    const matching = (meaningKeys ? sorted.filter((g) => meaningKeys.includes(g.key)) : sorted)
      .map((g) => {
        const items = g.items.filter(keep);
        return items.length === g.items.length ? g : { ...g, items };
      })
      .filter((g) => g.items.length > 0);
    return meaningKeys ? matching.sort((a, b) => meaningKeys.indexOf(a.key) - meaningKeys.indexOf(b.key)) : matching;
  }, [sorted, deferredQuery, parallel, language, status, origin, translation, book, meaningKeys]);

  const tableRows = useMemo(() => (layout === 'table' ? groups.flatMap((g) => g.items) : []), [layout, groups]);
  const parallelRows = useMemo(() => {
    if (!parallel) return [];
    const rows = groups.map((group) => ({ group, leftVerses: group.items.filter((v) => onSide(v, left)), rightVerses: group.items.filter((v) => onSide(v, right)) }));
    return rows.filter((r) => (bothSides ? r.leftVerses.length > 0 && r.rightVerses.length > 0 : r.leftVerses.length > 0 || r.rightVerses.length > 0));
  }, [parallel, groups, left, right, bothSides]);

  // A page holds lines in the table, and references in the other two views.
  const total = layout === 'table' ? tableRows.length : parallel ? parallelRows.length : groups.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(view.page, pages);
  const start = (page - 1) * pageSize;
  const visible = useMemo(() => groups.slice(start, start + pageSize), [groups, start, pageSize]);
  const visibleRows = useMemo(() => tableRows.slice(start, start + pageSize), [tableRows, start, pageSize]);
  const visibleParallel = useMemo(() => parallelRows.slice(start, start + pageSize), [parallelRows, start, pageSize]);
  const shownCount = Math.min(pageSize, total - start);
  const records = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);
  const filtered = query !== '' || (!parallel && (language !== 'all' || translation !== 'all')) || status !== 'all' || origin !== 'all' || book !== 'all' || meaningKeys !== null;
  const rangeText =
    total === 0
      ? ''
      : layout === 'table'
        ? `${start + 1}–${start + shownCount} of ${total} ${total === 1 ? 'verse' : 'verses'}`
        : parallel
          ? `${start + 1}–${start + shownCount} of ${total} ${total === 1 ? 'reference' : 'references'}`
          : `${start + 1}–${start + shownCount} of ${total} ${total === 1 ? 'reference' : 'references'}, ${records} ${records === 1 ? 'verse' : 'verses'}`;

  const goToPage = (n: number) => {
    setView({ page: n });
    top.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="scroll-stable h-full min-w-0" data-testid="bibles-page">
      <div ref={top} />
      <div className={PAGE}>
        <PageHeader
          icon={library === 'verse' ? BookMarked : BookText}
          tone={library === 'verse' ? 'pv' : 'lessons'}
          title={library === 'verse' ? 'Verse Library' : 'Verses from lessons'}
          titleTestId="bibles-title"
          descriptionTestId="bibles-policy"
          description={
            <>
              {library === 'verse'
                ? 'Verses read from your pastoral visit documents and imported from your Excel files. Verses read from worship service lessons are kept apart, in the Lesson Library.'
                : 'Verses read from your worship service lesson documents, exactly as printed or scanned. Verses from pastoral visits and Excel files are kept apart, in the Verse Library.'}{' '}
              Verified text is locked permanently, and the AI can never change it.
              <span className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1"><BadgeCheck size={13} className="text-ok" /> {stats.verified} of {stats.total} verified</span>
                {library === 'verse' && stats.total > 0 && (
                  <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="bibles-origin-counts">
            <span className="inline-flex items-center gap-1"><FileText size={12} className="text-pv" /> {stats.total - stats.imported} read from uploaded documents</span>
            <span className="inline-flex items-center gap-1"><FileSpreadsheet size={12} className="text-ok" /> {stats.imported} imported from Excel</span>
                  </span>
                )}
              </span>
            </>
          }
          actions={
            library === 'verse' ? (
              <button className="btn" data-testid="bibles-import" onClick={() => navigate('/import')}>
                <FileSpreadsheet size={14} /> Import from Excel
              </button>
            ) : undefined
          }
        />
        {rowsToFix > 0 && (
          <p className="m-0 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-warn/40 bg-warn/5 px-3 py-2 text-[13px] text-warn" data-testid="bibles-rows-to-fix">
            {rowsToFix} imported {rowsToFix === 1 ? 'row was' : 'rows were'} left out and {rowsToFix === 1 ? 'needs' : 'need'} fixing.
            <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="bibles-rows-to-fix-open" onClick={() => navigate('/import#rows-to-fix')}>Fix them</button>
          </p>
        )}
        <div className="page-toolbar z-10 mb-5 border-b border-line bg-bg pt-2 pb-4 lg:pt-3" data-testid="bibles-toolbar">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 basis-52 flex-1">
              <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <input className="field !pl-9" placeholder="Search references or wording" aria-label="Search verses" data-testid="bibles-search" value={query} onChange={(e) => { setView({ query: e.target.value }); setMeaningKeys(null); }} />
            </div>
            <button className="btn" data-testid="bibles-meaning" disabled={!query.trim() || meaningBusy} onClick={findByMeaning}>
              {meaningBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Find by meaning
            </button>
            <button className="btn" data-testid="bibles-review" onClick={() => openReview(library)}>
              <ListChecks size={14} /> Review verses
            </button>
            <div className="flex rounded-lg border border-line" role="group" aria-label="View" data-testid="bibles-layout">
              {LAYOUTS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={`tap flex min-h-[34px] items-center gap-1 border-0 px-2.5 text-xs first:rounded-l-lg last:rounded-r-lg max-lg:min-h-11 ${layout === id ? 'bg-raised font-semibold text-fg' : 'bg-transparent text-muted hover:text-fg'}`}
                  aria-pressed={layout === id}
                  data-testid={`bibles-layout-${id}`}
                  onClick={() => {
                    rememberLayout(id);
                    setView({ layout: id });
                  }}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" aria-label="Filter by book" data-testid="bibles-book" value={book} onChange={(e) => setView({ book: e.target.value === 'all' ? 'all' : Number(e.target.value) })}>
              <option value="all">All books</option>
              {books.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            {!parallel && (
              <>
                <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" aria-label="Filter by translation" data-testid="bibles-translation" value={translation} onChange={(e) => setView({ translation: e.target.value })}>
                  <option value="all">All translations</option>
                  {translations.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" aria-label="Filter by language" data-testid="bibles-language" value={language} onChange={(e) => setView({ language: e.target.value as View['language'] })}>
                  <option value="all">All languages</option>
                  <option value="tl">Tagalog</option>
                  <option value="en">English</option>
                </select>
              </>
            )}
            {library === 'verse' && (
              <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" aria-label="Filter by source" data-testid="bibles-origin" value={origin} onChange={(e) => setView({ origin: e.target.value as View['origin'] })}>
                <option value="all">All sources</option>
                <option value="pdf">Read from uploaded documents</option>
                <option value="import">Imported from Excel</option>
              </select>
            )}
            <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" aria-label="Filter by status" data-testid="bibles-status" value={status} onChange={(e) => setView({ status: e.target.value as View['status'] })}>
              <option value="all">All statuses</option>
              <option value="unverified">Unverified</option>
              <option value="verified">Verified</option>
            </select>
            {filtered && (
              <button className="btn !min-h-[34px] max-lg:!min-h-11" data-testid="bibles-clear" onClick={() => { setView(NO_FILTERS); setMeaningKeys(null); }}>
                <X size={14} /> Clear filters
              </button>
            )}
            <span className="ml-auto text-xs text-muted tabular-nums" role="status" data-testid="bibles-range">
              {rangeText}
            </span>
          </div>
          {parallel && (
            <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="parallel-controls">
              {([['left', 'Left side', left], ['right', 'Right side', right]] as const).map(([key, label, value]) => (
                <label key={key} className="flex items-center gap-1.5 text-xs text-muted">
                  {label}
                  <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" data-testid={`parallel-${key}`} value={value} onChange={(e) => setView({ [key]: e.target.value })}>
                    <option value="lang:en">English</option>
                    <option value="lang:tl">Tagalog</option>
                    {translations.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              ))}
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" data-testid="parallel-both" checked={bothSides} onChange={(e) => setView({ bothSides: e.target.checked })} />
                Only verses on both sides
              </label>
            </div>
          )}
          {pages > 1 && (
            <div className="mt-3">
              <Pagination page={page} pages={pages} onPage={goToPage} position="top" />
            </div>
          )}
        </div>
        {meaningKeys && (
          <p className="m-0 mb-3 flex items-center gap-2 text-[13px] text-muted" data-testid="bibles-meaning-note">
            Verses related in meaning to "{query}", closest first. These are suggestions from the local AI.
            <button className="icon-btn" aria-label="Clear search by meaning" data-testid="bibles-meaning-clear" onClick={() => setMeaningKeys(null)}><X size={14} /></button>
          </p>
        )}
        {total === 0 ? (
          <p className="py-14 text-center text-[13px] text-muted" data-testid="bibles-empty">
            {verses.length === 0 ? (library === 'verse' ? 'No verses yet. Upload a pastoral visit PDF or DOCX, or import an Excel file, and its verses will appear here.' : 'No verses yet. Upload a lesson PDF or DOCX, and the verses read from it will appear here.') : meaningKeys ? 'No verses are close in meaning.' : parallel && groups.length > 0 ? 'No verses match these two sides. Choose another side, or turn off "Only verses on both sides".' : 'No verses match these filters.'}
          </p>
        ) : (
          <>
            {layout === 'table' && <VerseTable rows={visibleRows} query={deferredQuery} />}
            {parallel && (
              <ul className="m-0 list-none space-y-2 p-0" data-testid="bibles-parallel">
                {visibleParallel.map(({ group, leftVerses, rightVerses }) => (
                  <li key={group.key} className="rounded-lg border border-line bg-panel" data-testid="parallel-row" data-key={group.key}>
                    <h2 className="m-0 border-b border-line px-2.5 py-1.5 text-[13px] font-semibold" data-testid="parallel-title">
                      {group.items[0].ref_en}
                      {group.items[0].ref_tl !== group.items[0].ref_en && <span className="font-normal text-muted"> · {group.items[0].ref_tl}</span>}
                    </h2>
                    <div className="grid grid-cols-1 divide-line max-md:divide-y md:grid-cols-2 md:divide-x">
                      <ParallelSide verses={leftVerses} side={left} query={deferredQuery} testId="parallel-side-left" />
                      <ParallelSide verses={rightVerses} side={right} query={deferredQuery} testId="parallel-side-right" />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {layout === 'cards' && (
              <ul className="m-0 list-none space-y-3 p-0" data-testid="bibles-groups">
                {visible.map((g) => (
                  <ReferenceGroup key={g.key} group={g} query={deferredQuery} />
                ))}
              </ul>
            )}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <Pagination page={page} pages={pages} onPage={goToPage} />
              {total > PAGE_SIZES[0] && (
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  Per page
                  <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" data-testid="bibles-page-size" value={pageSize} onChange={(e) => setView({ pageSize: Number(e.target.value) })}>
                    {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export { errorText };
