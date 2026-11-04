import { useCallback, useMemo, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import { LessonRows, useVisibleLessons } from '../components/LessonList';
import { navigate, selectLesson, setQuery, setState, updateFilters, useStore, verseGroups } from '../store';

export function SearchPage() {
  const query = useStore((s) => s.filters.query);
  const verses = useStore((s) => s.verses);
  const { visible } = useVisibleLessons();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const onOpen = useCallback((id: string) => {
    selectLesson(id);
    setState({ viewerOpen: true });
    navigate('/');
  }, []);

  const verseMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return verseGroups(verses)
      .filter((g) => g.items.some((v) => `${v.ref_en} ${v.ref_tl} ${v.ref_printed} ${v.text}`.toLowerCase().includes(q)))
      .slice(0, 20);
  }, [verses, query]);

  return (
    <div className="scroll-stable mx-auto h-full max-w-3xl p-3" data-testid="search-page">
      <h1 className="m-0 mb-2 text-lg font-semibold">Search</h1>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <input ref={inputRef} className="field !pr-11 !pl-9" placeholder="Search lessons, verses, places" aria-label="Search lessons and verses" data-testid="page-search-input" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && (
          <button className="icon-btn absolute top-0 right-0" aria-label="Clear search" data-testid="page-search-clear" onClick={() => setQuery('')}>
            <X size={16} />
          </button>
        )}
      </div>
      {!query.trim() ? (
        <p className="mt-6 text-center text-[13px] text-muted" data-testid="search-hint">Search lesson titles, lesson text, places, references and verse wording.</p>
      ) : (
        <>
          <h2 className="mt-4 mb-1 text-xs font-medium text-muted" data-testid="search-lessons-heading">Lessons ({visible.length})</h2>
          <LessonRows visible={visible} onOpen={onOpen} empty={<p className="m-0 p-2 text-[13px] text-muted" data-testid="search-none">No lessons match.</p>} />
          <h2 className="mt-4 mb-1 text-xs font-medium text-muted">Verses ({verseMatches.length})</h2>
          <ul className="m-0 list-none space-y-1 p-0" data-testid="search-verses">
            {verseMatches.map((g) => (
              <li key={g.key}>
                <button
                  className="tap min-h-11 w-full rounded-lg border border-line bg-transparent px-3 py-2 text-left hover:bg-raised"
                  data-testid="search-verse"
                  onClick={() => {
                    updateFilters({ verseKey: g.key, query: '' });
                    setState({ contentMatches: null });
                    navigate('/');
                  }}
                >
                  <span className="font-medium">{g.items[0].ref_en}</span>
                  <span className="block truncate text-xs text-muted">{g.items[0].text}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
