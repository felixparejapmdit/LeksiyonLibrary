import { useCallback, useMemo, useRef, useEffect, useState } from 'react';
import { Loader2, Search, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import { LessonRows, useVisibleLessons } from '../components/LessonList';
import { PAGE, PageHeader } from '../components/PageHeader';
import { errorText, navigate, selectLesson, setQuery, setState, toast, updateFilters, useStore, verseGroups } from '../store';

export function SearchPage() {
  const query = useStore((s) => s.filters.query);
  const verses = useStore((s) => s.verses);
  const { visible } = useVisibleLessons();
  const inputRef = useRef<HTMLInputElement>(null);
  const [meaning, setMeaning] = useState<{ query: string; keys: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const related = useMemo(() => {
    if (!meaning || meaning.query !== query) return null;
    const groups = verseGroups(verses);
    return meaning.keys.flatMap((k) => groups.filter((g) => g.key === k));
  }, [meaning, query, verses]);

  const findByMeaning = async () => {
    setBusy(true);
    try {
      const res = await api.searchMeaning(query);
      if (res.available) setMeaning({ query, keys: res.keys });
      else toast('Search by meaning needs the local AI model. Searching by words still works.', 'error');
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };

  const openVerse = (key: string) => {
    updateFilters({ verseKey: key, query: '' });
    setState({ contentMatches: null });
    navigate('/');
  };

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
    <div className="scroll-stable h-full" data-testid="search-page">
      <div className={`${PAGE} max-w-3xl`}>
      <PageHeader icon={Search} tone="lessons" title="Search" description="Lesson titles, lesson text, places, references and verse wording, all searched on this computer." />
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
        <p className="mt-8 text-center text-[13px] text-muted" data-testid="search-hint">Type a word, a place or a reference, such as John 3:16.</p>
      ) : (
        <>
          <h2 className="mt-6 mb-2 text-xs font-semibold tracking-wider text-muted uppercase" data-testid="search-lessons-heading">Lessons ({visible.length})</h2>
          <LessonRows visible={visible} onOpen={onOpen} empty={<p className="m-0 p-2 text-[13px] text-muted" data-testid="search-none">No lessons match.</p>} />
          <h2 className="mt-6 mb-2 text-xs font-semibold tracking-wider text-muted uppercase">Verses ({verseMatches.length})</h2>
          <ul className="m-0 list-none space-y-1 p-0" data-testid="search-verses">
            {verseMatches.map((g) => (
              <li key={g.key}>
                <button
                  className="tap min-h-11 w-full rounded-lg border border-line bg-transparent px-3 py-2 text-left hover:bg-raised"
                  data-testid="search-verse"
                  onClick={() => openVerse(g.key)}
                >
                  <span className="font-medium">{g.items[0].ref_en}</span>
                  <span className="block truncate text-xs text-muted">{g.items[0].text}</span>
                </button>
              </li>
            ))}
          </ul>
          <button className="btn mt-4" data-testid="search-meaning" disabled={busy} onClick={findByMeaning}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Find verses by meaning
          </button>
          {related && (
            <>
              <h2 className="mt-5 mb-2 text-xs font-semibold tracking-wider text-muted uppercase" data-testid="search-meaning-heading">Related in meaning ({related.length})</h2>
              {related.length === 0 && <p className="m-0 p-2 text-[13px] text-muted" data-testid="search-meaning-none">No verses are close in meaning.</p>}
              <ul className="m-0 list-none space-y-1 p-0" data-testid="search-meaning-list">
                {related.map((g) => (
                  <li key={g.key}>
                    <button className="tap min-h-11 w-full rounded-lg border border-line bg-transparent px-3 py-2 text-left hover:bg-raised" data-testid="search-meaning-verse" onClick={() => openVerse(g.key)}>
                      <span className="font-medium">{g.items[0].ref_en}</span>
                      <span className="block truncate text-xs text-muted">{g.items[0].text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      </div>
    </div>
  );
}
