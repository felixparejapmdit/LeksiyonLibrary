import { useEffect, useMemo, useState } from 'react';
import { api, type Language, type Lesson, type Verse } from './api';
import { matchesSearch, normalizeSearch } from './search';
import { lessonSearchText, useStore } from './store';

export type SearchKind = 'all' | 'lessons' | 'visits' | 'verses' | 'locations';
export interface SearchOptions {
  kind: SearchKind;
  language: Language | 'all';
  year: string;
  status: 'all' | 'review' | 'reviewed';
  translation: string;
}
export const DEFAULT_SEARCH: SearchOptions = { kind: 'all', language: 'all', year: 'all', status: 'all', translation: 'all' };
export const verseSearchText = (v: Verse) => `${v.ref_en} ${v.ref_tl} ${v.ref_printed} ${v.version} ${v.text} ${v.import_source}`;

/** Global results ignore the current library/year, unless a search filter selects it. */
export function useGlobalSearch(query: string, options: SearchOptions) {
  const lessons = useStore((s) => s.lessons);
  const verses = useStore((s) => s.verses);
  const [body, setBody] = useState<{ query: string; ids: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let alive = true;
    setUnavailable(false);
    if (!query.trim()) { setLoading(false); setBody(null); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      api.search(query).then(({ lesson_ids }) => {
        if (alive) setBody({ query, ids: lesson_ids });
      }).catch(() => { if (alive) setUnavailable(true); }).finally(() => { if (alive) setLoading(false); });
    }, 160);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, lessons]);

  return useMemo(() => {
    const { language, year, status, translation, kind } = options;
    const inYear = (l: Lesson) => year === 'all' || String(l.year ?? 0) === year;
    const scopedLessons = lessons.filter((l) => inYear(l) && (language === 'all' || l.language === language)
      && (status === 'all' || (status === 'review' ? l.needs_check : !l.needs_check)));
    const foundLessons = !query.trim() || translation !== 'all' || !['all', 'lessons', 'visits'].includes(kind) ? [] : scopedLessons.filter((l) =>
      (kind !== 'lessons' || l.category !== 'pastoral') && (kind !== 'visits' || l.category === 'pastoral')
      && (matchesSearch(lessonSearchText(l), query) || (body?.query === query && body.ids.includes(l.id))));
    const yearLessonIds = new Set(lessons.filter(inYear).map((l) => l.id));
    const eligibleVerses = verses.filter((v) => (language === 'all' || v.language === language)
      && (translation === 'all' || v.version === translation)
      && (status === 'all' || (status === 'review' ? v.status === 'unverified' : v.status === 'verified'))
      && (year === 'all' || v.sources.some((s) => yearLessonIds.has(s.lesson_id))));
    const foundVerses = !query.trim() || !['all', 'verses'].includes(kind) ? [] : eligibleVerses.filter((v) => matchesSearch(verseSearchText(v), query));
    const locations = new Map<string, { key: string; label: string; query: string; scope: 'pastoral' | 'lessons'; count: number }>();
    if (query.trim() && translation === 'all' && ['all', 'locations'].includes(kind)) {
      for (const l of scopedLessons) {
        const label = [l.local_congregation, l.district].filter(Boolean).join(' · ') || l.location;
        if (!label || !matchesSearch(label, query)) continue;
        const key = `${l.category === 'pastoral' ? 'pastoral' : 'lessons'}:${normalizeSearch(label)}`;
        const previous = locations.get(key);
        if (previous) previous.count++;
        else locations.set(key, { key, label, query: [l.local_congregation, l.district].filter(Boolean).join(' ') || l.location, scope: l.category === 'pastoral' ? 'pastoral' : 'lessons', count: 1 });
      }
    }
    return { lessons: foundLessons, verses: foundVerses, eligibleVerses, locations: [...locations.values()], loading, unavailable,
      years: [...new Set(lessons.map((l) => l.year ?? 0))].sort((a, b) => b - a),
      translations: [...new Set(verses.map((v) => v.version).filter(Boolean))].sort(),
    };
  }, [lessons, verses, options, query, body, loading, unavailable]);
}
