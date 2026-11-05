import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, FileSearch, ListChecks, Lock, Loader2, PencilLine, Search, ShieldAlert, Sparkles, X } from 'lucide-react';
import { api, type Verse } from '../api';
import { VerseCorrectionDialog } from '../components/Overlays';
import { Highlight } from '../components/LessonList';
import { scopeNames } from '../components/VerseContext';
import { askConfirm, errorText, getState, navigate, resetFilters, selectLesson, setState, toast, useStore, verseGroups } from '../store';

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

const VerseCard = memo(function VerseCard({ verse, query, alone }: { verse: Verse; query: string; alone: boolean }) {
  const [correcting, setCorrecting] = useState(false);
  const verified = verse.status === 'verified';
  const source = verse.sources[0];
  return (
    <div className={`flex h-full flex-col ${alone ? '' : 'rounded-md border border-line p-2.5'}`} data-testid="verse-card" data-verse-id={verse.id} data-language={verse.language} data-status={verse.status}>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
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
        {verse.text ? <Highlight text={verse.text} query={query} /> : <span className="text-muted">Reference only. No text was printed in this lesson.</span>}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {verse.import_source && <span className="mr-auto text-xs text-muted" data-testid="verse-import-source">From {verse.import_source}</span>}
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

interface View {
  query: string;
  language: 'all' | 'en' | 'tl';
  status: 'all' | 'verified' | 'unverified';
  translation: string;
  book: number | 'all';
  page: number;
  pageSize: number;
}

const NO_FILTERS = { query: '', language: 'all', status: 'all', translation: 'all', book: 'all' } as const;

// Kept while the app is open, so coming back to this page finds it as it was left.
let savedView: View = { ...NO_FILTERS, page: 1, pageSize: 25 };

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

function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (n: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav className="flex flex-wrap items-center justify-center gap-1" aria-label="Pages" data-testid="bibles-pagination">
      <button className="btn !min-h-8 max-lg:!min-h-11" aria-label="Previous page" data-testid="bibles-page-prev" disabled={page <= 1} onClick={() => onPage(page - 1)}>
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
            data-testid="bibles-page-number"
            onClick={() => onPage(n)}
          >
            {n}
          </button>
        ),
      )}
      <button className="btn !min-h-8 max-lg:!min-h-11" aria-label="Next page" data-testid="bibles-page-next" disabled={page >= pages} onClick={() => onPage(page + 1)}>
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
            {group.items.length} records{versions.length > 0 ? ` · ${versions.slice(0, 4).join(', ')}${versions.length > 4 ? ` and ${versions.length - 4} more` : ''}` : ''}
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

export function BiblesPage() {
  const verses = useStore((s) => s.verses);
  const [view, setViewState] = useState<View>(savedView);
  const { query, language, status, translation, book, pageSize } = view;
  const setView = (patch: Partial<View>) => setViewState((v) => ({ ...v, page: 1, ...patch }));
  useEffect(() => {
    savedView = view;
  }, [view]);
  // Typing stays instant: the list catches up just after, rather than holding up each key.
  const deferredQuery = useDeferredValue(query);
  const [meaningKeys, setMeaningKeys] = useState<string[] | null>(null);
  const [meaningBusy, setMeaningBusy] = useState(false);
  const top = useRef<HTMLDivElement>(null);

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

  const stats = useMemo(() => ({ verified: verses.filter((v) => v.status === 'verified').length, total: verses.length }), [verses]);
  const translations = useMemo(() => [...new Set(verses.map((v) => v.version).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [verses]);
  const books = useMemo(() => {
    const names = new Map<number, string>();
    for (const v of verses) if (!names.has(v.book_id)) names.set(v.book_id, scopeNames(v.ref_en).book);
    return [...names.entries()].sort((a, b) => a[0] - b[0]);
  }, [verses]);

  // Sorted once for each change to the library, not again for every keystroke or filter.
  const sorted = useMemo(() => verseGroups(verses).sort((a, b) => a.book - b.book || byReference.compare(a.items[0].ref_en, b.items[0].ref_en)), [verses]);

  const groups = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const keep = (v: Verse) =>
      (language === 'all' || v.language === language) &&
      (status === 'all' || v.status === status) &&
      (translation === 'all' || v.version === translation) &&
      (book === 'all' || v.book_id === book) &&
      (meaningKeys !== null || !q || searchTextOf(v).includes(q));
    const matching = (meaningKeys ? sorted.filter((g) => meaningKeys.includes(g.key)) : sorted)
      .map((g) => {
        const items = g.items.filter(keep);
        return items.length === g.items.length ? g : { ...g, items };
      })
      .filter((g) => g.items.length > 0);
    return meaningKeys ? matching.sort((a, b) => meaningKeys.indexOf(a.key) - meaningKeys.indexOf(b.key)) : matching;
  }, [sorted, deferredQuery, language, status, translation, book, meaningKeys]);

  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const page = Math.min(view.page, pages);
  const start = (page - 1) * pageSize;
  const visible = useMemo(() => groups.slice(start, start + pageSize), [groups, start, pageSize]);
  const records = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);
  const filtered = query !== '' || language !== 'all' || status !== 'all' || translation !== 'all' || book !== 'all' || meaningKeys !== null;

  const goToPage = (n: number) => {
    setView({ page: n });
    top.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="scroll-stable h-full" data-testid="bibles-page">
      <div ref={top} />
      <div className="mx-auto max-w-6xl p-3 lg:p-4">
        <h1 className="m-0 text-lg font-semibold">Bibles Library</h1>
        <p className="m-0 mt-0.5 mb-3 flex items-start gap-1.5 text-[13px] text-muted" data-testid="bibles-policy">
          <BadgeCheck size={15} className="mt-0.5 flex-none text-ok" />
          Verses are collected from your lessons exactly as scanned, and from sheets you import in Settings. Verified text is locked permanently, and the AI can never change it. {stats.verified} of {stats.total} verified.
        </p>
        <div className="z-10 -mx-3 mb-3 border-b border-line bg-bg px-3 pb-2 lg:sticky lg:top-0 lg:-mx-4 lg:px-4 lg:pt-1" data-testid="bibles-toolbar">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <input className="field !pl-9" placeholder="Search references or wording" aria-label="Search verses" data-testid="bibles-search" value={query} onChange={(e) => { setView({ query: e.target.value }); setMeaningKeys(null); }} />
            </div>
            <button className="btn" data-testid="bibles-meaning" disabled={!query.trim() || meaningBusy} onClick={findByMeaning}>
              {meaningBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Find by meaning
            </button>
            <button className="btn" data-testid="bibles-review" onClick={() => navigate('/review')}>
              <ListChecks size={14} /> Review verses
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" aria-label="Filter by book" data-testid="bibles-book" value={book} onChange={(e) => setView({ book: e.target.value === 'all' ? 'all' : Number(e.target.value) })}>
              <option value="all">All books</option>
              {books.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" aria-label="Filter by translation" data-testid="bibles-translation" value={translation} onChange={(e) => setView({ translation: e.target.value })}>
              <option value="all">All translations</option>
              {translations.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" aria-label="Filter by language" data-testid="bibles-language" value={language} onChange={(e) => setView({ language: e.target.value as View['language'] })}>
              <option value="all">All languages</option>
              <option value="tl">Tagalog</option>
              <option value="en">English</option>
            </select>
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
              {groups.length === 0 ? '' : `${start + 1}–${start + visible.length} of ${groups.length} ${groups.length === 1 ? 'reference' : 'references'}, ${records} ${records === 1 ? 'record' : 'records'}`}
            </span>
          </div>
        </div>
        {meaningKeys && (
          <p className="m-0 mb-3 flex items-center gap-2 text-[13px] text-muted" data-testid="bibles-meaning-note">
            Verses related in meaning to "{query}", closest first. These are suggestions from the local AI.
            <button className="icon-btn" aria-label="Clear search by meaning" data-testid="bibles-meaning-clear" onClick={() => setMeaningKeys(null)}><X size={14} /></button>
          </p>
        )}
        {groups.length === 0 ? (
          <p className="py-14 text-center text-[13px] text-muted" data-testid="bibles-empty">
            {verses.length === 0 ? 'No verses yet. Upload a lesson, or import a sheet in Settings, and its verses will appear here.' : meaningKeys ? 'No verses are close in meaning.' : 'No verses match these filters.'}
          </p>
        ) : (
          <>
            <ul className="m-0 list-none space-y-3 p-0" data-testid="bibles-groups">
              {visible.map((g) => (
                <ReferenceGroup key={g.key} group={g} query={deferredQuery} />
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <Pagination page={page} pages={pages} onPage={goToPage} />
              {groups.length > PAGE_SIZES[0] && (
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
