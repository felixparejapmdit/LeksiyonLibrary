import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BookMarked, ChevronDown, FileText, Loader2, MapPin, Search, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { api, type Lesson, type Verse } from '../api';
import { DEFAULT_SEARCH, useGlobalSearch, type SearchOptions } from '../globalSearch';
import { errorText, formatLessonDate, getState, libraryOf, navigate, openLesson, openScope, setState, toast, updateFilters, useStore, verseGroups } from '../store';
import { LessonRows } from './LessonList';
import { VerseText } from './VerseText';

const closeSearch = () => setState({ advancedSearchOpen: false });
const resultStyle = 'tap w-full min-w-0 rounded-lg border border-line bg-panel p-3 text-left hover:bg-raised';

export function openSearchVerse(verse: Verse) {
  setState({ verseTargetId: verse.id, advancedSearchOpen: false });
  navigate(libraryOf(verse) === 'lesson' ? '/lesson-verses' : '/bibles');
}

function openSearchLesson(lesson: Lesson) {
  closeSearch();
  openScope(lesson.category === 'pastoral' ? 'pastoral' : 'lessons');
  openLesson(lesson.id);
}

function SearchFilters({ options, years, translations, onChange }: {
  options: SearchOptions; years: number[]; translations: string[]; onChange: (patch: Partial<SearchOptions>) => void;
}) {
  const field = (label: string, key: keyof SearchOptions, choices: [string, string][]) => (
    <label className="min-w-0 text-muted" key={key}>{label}
      <select className="field mt-1 !min-h-9 !py-1 !text-xs max-lg:!min-h-11" data-testid={`advanced-search-${key}`} value={options[key]}
        onChange={(e) => onChange({
          [key]: e.target.value,
          ...(key === 'translation' && e.target.value !== 'all' ? { kind: 'verses' } : {}),
          ...(key === 'kind' && !['all', 'verses'].includes(e.target.value) ? { translation: 'all' } : {}),
        } as Partial<SearchOptions>)}>
        {choices.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </select>
    </label>
  );
  return <details open className="text-xs" data-testid="advanced-search-filters">
    <summary className="mb-2 flex w-fit cursor-pointer items-center gap-1.5 text-muted"><SlidersHorizontal size={13} /> Filters</summary>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {field('Search in', 'kind', [['all', 'Everything'], ['lessons', 'Lesson Library'], ['visits', 'Pastoral Visits'], ['verses', 'Verses'], ['locations', 'Local / District / Location']])}
      {field('Language', 'language', [['all', 'Both languages'], ['tl', 'Tagalog'], ['en', 'English']])}
      {field('Year', 'year', [['all', 'All years'], ...years.map((year): [string, string] => [String(year), year ? String(year) : 'No date'])])}
      {field('Status', 'status', [['all', 'All statuses'], ['review', 'Needs review'], ['reviewed', 'Checked / verified']])}
      {field('Translation', 'translation', [['all', 'All translations'], ...translations.map((version): [string, string] => [version, version])])}
    </div>
    {Object.keys(DEFAULT_SEARCH).some((key) => options[key as keyof SearchOptions] !== DEFAULT_SEARCH[key as keyof SearchOptions]) &&
      <button className="btn mt-2 !min-h-8" data-testid="advanced-search-reset" onClick={() => onChange(DEFAULT_SEARCH)}><X size={12} /> Clear filters</button>}
  </details>;
}

/** The Search page and Ctrl+K share the same records, filters, and result actions. */
export function GlobalSearchContent({ mode = 'page' }: { mode?: 'page' | 'dialog' }) {
  const query = useStore((s) => s.globalSearchQuery);
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH);
  const [limit, setLimit] = useState(20);
  const inputRef = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const results = useGlobalSearch(query, options);
  const [meaning, setMeaning] = useState<{ query: string; keys: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const verseResults = useMemo(() => verseGroups(results.verses), [results.verses]);
  const related = useMemo(() => meaning?.query === query && ['all', 'verses'].includes(options.kind)
    ? verseGroups(results.eligibleVerses).filter((g) => meaning.keys.includes(g.key)) : null, [meaning, query, options.kind, results.eligibleVerses]);
  useEffect(() => { if (mode === 'page') inputRef.current?.focus(); }, [mode]);
  const changeQuery = (value: string) => {
    setState({ globalSearchQuery: value });
    setLimit(20); setMeaning(null);
  };
  const filter = (patch: Partial<SearchOptions>) => {
    setOptions((current) => ({ ...current, ...patch })); setLimit(20); setMeaning(null);
  };
  const openVerse = (verse: Verse) => {
    if (mode === 'page' && verse.sources.length) {
      openScope('all');
      updateFilters({ verseKey: verse.canonical_key });
    } else openSearchVerse(verse);
  };
  const findMeaning = async () => {
    setBusy(true);
    try {
      const result = await api.searchMeaning(query);
      if (result.available) setMeaning({ query, keys: result.keys });
      else toast('Meaning search needs the local AI model. English and Tagalog keyword search still works.', 'error');
    } catch (e) { toast(errorText(e), 'error'); }
    setBusy(false);
  };
  const browseResults = (event: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    if (event.target !== inputRef.current && !(event.target as HTMLElement).closest('[data-search-result]')) return;
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-search-result]') ?? [])];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.findIndex((button) => button === event.target || button.contains(event.target as Node));
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus(); buttons[next].scrollIntoView({ block: 'nearest' });
  };
  const lessonCount = results.lessons.length;
  const resultCount = lessonCount + verseResults.length + results.locations.length;
  const sectionHeading = 'mt-5 mb-2 flex items-center gap-2 text-xs font-semibold tracking-wider text-muted uppercase';
  return <div ref={root} className={`min-h-0 min-w-0 ${mode === 'dialog' ? 'flex flex-1 flex-col overflow-hidden' : ''}`} onKeyDown={browseResults}>
    <div className={`space-y-3 ${mode === 'dialog' ? 'flex-none border-b border-line px-4 pt-4 pb-3 sm:px-6' : ''}`}>
      <div className="relative">
        <Search size={17} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <input ref={inputRef} className="field !pr-11 !pl-10" type="search" placeholder="Search English or Tagalog words, references, or places" aria-label="Search everything"
          data-testid={mode === 'page' ? 'page-search-input' : 'advanced-search-input'} value={query} onChange={(e) => changeQuery(e.target.value)} />
        {query && <button className="icon-btn absolute top-1/2 right-0 -translate-y-1/2" aria-label="Clear search" data-testid={mode === 'page' ? 'page-search-clear' : 'advanced-search-clear'} onClick={() => changeQuery('')}><X size={15} /></button>}
      </div>
      <SearchFilters options={options} years={results.years} translations={results.translations} onChange={filter} />
    </div>
    <div className={`min-h-0 min-w-0 ${mode === 'dialog' ? 'scroll-stable flex-1 px-4 py-4 sm:px-6' : 'mt-5'}`} data-testid="global-search-results">
      {!query.trim() ? <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted" data-testid="search-hint">
        <Search size={24} className="mx-auto mb-3" />Search titles, issues, objectives, verse wording, document text, and places.
        <p className="m-0 mt-2 text-xs">English and Tagalog keywords and common bilingual terms are matched. Use Find by meaning for broader verse matches with local AI.</p>
      </div> : <>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted" role="status">
          <span data-testid="advanced-search-count">{resultCount} matching {resultCount === 1 ? 'result' : 'results'}</span>
          {results.loading && <span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Searching document text</span>}
        </div>
        {results.unavailable && <p className="mb-3 text-xs text-warn">Document-text search is unavailable. Matches from titles, metadata, and verses are still shown.</p>}
        <h2 className={sectionHeading} data-testid="search-lessons-heading"><FileText size={14} /> Lessons ({lessonCount})</h2>
        {mode === 'page' ? <LessonRows visible={results.lessons.slice(0, limit)} onOpen={(id) => { const lesson = results.lessons.find((l) => l.id === id); if (lesson) openSearchLesson(lesson); }}
          empty={<p className="m-0 mb-4 p-2 text-[13px] text-muted" data-testid="search-none">No lessons match.</p>} /> :
          <div className="space-y-2">{results.lessons.slice(0, limit).map((lesson) => <button key={lesson.id} className={resultStyle} data-search-result data-testid="advanced-search-lesson" onClick={() => openSearchLesson(lesson)}>
            <span className="block font-medium break-words">{lesson.title}</span>
            <span className="mt-1 block text-xs text-muted">{lesson.category === 'pastoral' ? 'Pastoral Visits' : 'Lesson Library'} · {lesson.language === 'tl' ? 'Tagalog' : 'English'}{formatLessonDate(lesson) ? ` · ${formatLessonDate(lesson)}` : ''}</span>
            <span className="mt-1 block text-xs text-muted break-words">{lesson.category === 'pastoral' ? [lesson.local_congregation, lesson.district].filter(Boolean).join(' · ') : lesson.issue}</span>
          </button>)}</div>}
        <h2 className={sectionHeading}><BookMarked size={14} /> Verses ({verseResults.length})</h2>
        <ul className="m-0 list-none space-y-2 p-0" data-testid="search-verses">{verseResults.slice(0, limit).map((group) => {
          const verse = group.items[0];
          return <li key={group.key}><button className={resultStyle} data-search-result data-testid={mode === 'page' ? 'search-verse' : 'advanced-search-verse'} onClick={() => openVerse(verse)}>
            <span className="block font-medium">{verse.ref_printed} <span className="font-normal text-muted">{verse.version}</span></span>
            <span className="mt-1 block text-xs text-muted">{libraryOf(verse) === 'lesson' ? 'Lesson Library' : 'Verse Library'} · {verse.language === 'tl' ? 'Tagalog' : 'English'}{group.items.length > 1 ? ` · ${group.items.length} records` : ''}</span>
            <span className="mt-2 line-clamp-2 block text-[13px] leading-relaxed"><VerseText text={verse.text || 'Reference only.'} query={query} /></span>
          </button></li>;
        })}</ul>
        <h2 className={sectionHeading}><MapPin size={14} /> Places ({results.locations.length})</h2>
        <div className="space-y-2">{results.locations.slice(0, limit).map((location) => <button key={location.key} className={resultStyle} data-search-result data-testid="advanced-search-location" onClick={() => {
          closeSearch(); openScope(location.scope === 'lessons' ? 'all' : 'pastoral'); updateFilters({ query: location.query });
        }}><span className="block font-medium break-words">{location.label}</span><span className="mt-1 block text-xs text-muted">{location.count} {location.count === 1 ? 'lesson or visit' : 'lessons and visits'}</span></button>)}</div>
        {!results.loading && !resultCount && <p className="rounded-lg border border-line p-5 text-center text-[13px] text-muted" data-testid="advanced-search-empty">No matches. Try another word or clear the filters.</p>}
        {(lessonCount > limit || verseResults.length > limit || results.locations.length > limit) && <button className="btn mt-4" data-testid="advanced-search-more" onClick={() => setLimit((value) => value + 20)}><ChevronDown size={14} /> Show more results</button>}
        {['all', 'verses'].includes(options.kind) && <button className="btn mt-5" data-testid="search-meaning" disabled={busy || !query.trim()} onClick={findMeaning}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Find verses by meaning</button>}
        {related && <section className="mt-5"><h2 className="mb-2 text-xs font-semibold text-muted" data-testid="search-meaning-heading">Related in meaning ({related.length})</h2>
          {!related.length && <p className="text-[13px] text-muted" data-testid="search-meaning-none">No verses are close in meaning.</p>}
          <div className="space-y-2" data-testid="search-meaning-list">{related.slice(0, limit).map((group) => <button key={group.key} className={resultStyle} data-search-result data-testid="search-meaning-verse" onClick={() => openVerse(group.items[0])}>
            <span className="font-medium">{group.items[0].ref_en}</span><span className="mt-1 block text-[13px] leading-relaxed"><VerseText text={group.items[0].text} /></span>
          </button>)}</div>
        </section>}
      </>}
    </div>
  </div>;
}

function SearchDialogBody() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector('input')?.focus();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="m-auto flex max-h-[90dvh] w-[calc(100%_-_1.5rem)] max-w-4xl min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/65"
    aria-labelledby="advanced-search-title" data-testid="advanced-search-dialog"
    onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
    }}
    onCancel={(e) => { e.preventDefault(); closeSearch(); }} onClick={(e) => {
      if (e.target !== e.currentTarget) return;
      const box = e.currentTarget.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) closeSearch();
    }}>
    <header className="flex flex-none items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
      <div className="min-w-0"><h2 id="advanced-search-title" className="m-0 text-base font-semibold">Search everything</h2><p className="m-0 mt-0.5 text-xs text-muted">Lessons, verses, issues, objectives, and places</p></div>
      <button className="icon-btn" aria-label="Close advanced search" data-testid="advanced-search-close" onClick={closeSearch}><X size={18} /></button>
    </header>
    <GlobalSearchContent mode="dialog" />
    <footer className="flex flex-none flex-wrap justify-between gap-2 border-t border-line px-4 py-2 text-[11px] text-muted sm:px-6"><span>↑ ↓ Browse · Enter Open · Esc Close</span><span>English / Tagalog · On this computer</span></footer>
  </dialog>;
}

export function AdvancedSearchDialog() {
  const open = useStore((s) => s.advancedSearchOpen);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setState({ welcomeOpen: false, advancedSearchOpen: !getState().advancedSearchOpen });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return open ? <SearchDialogBody /> : null;
}
