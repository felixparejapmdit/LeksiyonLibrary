import { memo, useMemo } from 'react';
import { useProgressive } from './Layout';
import { Calendar, CalendarDays, ClipboardCheck, Download, FileText, Folder, MapPin, Pencil, Trash2, X } from 'lucide-react';
import { api, lessonFileUrl, type Category, type Lesson } from '../api';
import {
  askConfirm,
  categoryLabel,
  formatLessonDate,
  matchesFilters,
  refreshAll,
  resetFilters,
  selectLesson,
  setState,
  sortLessons,
  toast,
  updateFilters,
  useStore,
  verseGroups,
} from '../store';

export function Highlight({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!terms.length) return [text];
    return text.split(new RegExp(`(${terms.join('|')})`, 'gi'));
  }, [text, query]);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

const tabs: { id: Category | 'all'; label: string; icon: typeof Folder }[] = [
  { id: 'all', label: 'All', icon: Folder },
  { id: 'midweek', label: 'Midweek', icon: Calendar },
  { id: 'weekend', label: 'Weekend', icon: CalendarDays },
  { id: 'pastoral', label: 'Pastoral Visits', icon: MapPin },
];

/** All Archives can show each category; the Lesson Library has no pastoral visits, and Pastoral Visits nothing else. */
export function CategoryTabs({ pool }: { pool: Lesson[] }) {
  const active = useStore((s) => s.filters.category);
  const scope = useStore((s) => s.filters.scope);
  if (scope === 'pastoral') return null;
  const shown = scope === 'lessons' ? tabs.filter((t) => t.id !== 'pastoral') : tabs;
  const counts: Record<string, number> = { all: pool.length, midweek: 0, weekend: 0, pastoral: 0 };
  for (const l of pool) counts[l.category]++;
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Lesson category" data-testid="category-tabs">
      {shown.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          role="tab"
          aria-selected={active === id}
          data-testid={`tab-${id}`}
          className={`tap flex min-h-[34px] flex-none items-center gap-1.5 rounded-full border px-3 text-xs font-medium max-lg:min-h-11 ${active === id ? 'border-accent2 bg-accent2/15 text-fg' : 'border-line text-muted hover:bg-raised'}`}
          onClick={() => updateFilters({ category: id })}
        >
          <Icon size={13} /> {label}
          <span className="tabular-nums opacity-80" data-testid={`tab-count-${id}`}>{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}

function Chip({ label, onClear, testId }: { label: string; onClear: () => void; testId: string }) {
  return (
    <span className="flex items-center gap-1 rounded-full border border-line bg-raised py-0.5 pr-0.5 pl-2.5 text-xs" data-testid={testId}>
      {label}
      <button className="icon-btn !h-6 !w-6 max-lg:!h-8 max-lg:!w-8" aria-label={`Remove filter ${label}`} data-testid={`${testId}-clear`} onClick={onClear}>
        <X size={12} />
      </button>
    </span>
  );
}

export function FilterChips() {
  const f = useStore((s) => s.filters);
  const verses = useStore((s) => s.verses);
  const folders = useStore((s) => s.folders);
  const verseLabel = useMemo(() => verseGroups(verses).find((g) => g.key === f.verseKey)?.items[0].ref_printed, [verses, f.verseKey]);
  const folderName = folders.find((x) => x.id === f.folderId)?.name;
  if (f.year === null && !f.verseKey && !f.query.trim() && !f.folderId && !f.toCheck) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1.5" data-testid="filter-chips">
      <span className="text-xs text-muted">Filtered by:</span>
      {f.year !== null && <Chip label={`Year: ${f.year}`} onClear={() => updateFilters({ year: null })} testId="chip-year" />}
      {f.folderId && <Chip label={`Folder: ${folderName ?? ''}`} onClear={() => updateFilters({ folderId: null })} testId="chip-folder" />}
      {f.toCheck && <Chip label="Not checked yet" onClear={() => updateFilters({ toCheck: false })} testId="chip-to-check" />}
      {f.verseKey && <Chip label={verseLabel ?? f.verseKey} onClear={() => updateFilters({ verseKey: null })} testId="chip-verse" />}
      {f.query.trim() && <Chip label={`Keyword: "${f.query.trim()}"`} onClear={() => { setState({ contentMatches: null }); updateFilters({ query: '' }); }} testId="chip-query" />}
      <button className="tap ml-auto min-h-8 rounded-md px-2 text-xs text-muted hover:bg-raised hover:text-fg max-lg:min-h-11" data-testid="reset-filters" onClick={resetFilters}>
        Reset Filters
      </button>
    </div>
  );
}

const Row = memo(function Row({ lesson, selected, query, onOpen }: { lesson: Lesson; selected: boolean; query: string; onOpen: (id: string) => void }) {
  const meta = [formatLessonDate(lesson), lesson.location].filter(Boolean).join(' · ');
  return (
    <li className="row-cv" data-testid="lesson-row" data-lesson-id={lesson.id} data-selected={selected}>
      <div className={`tap group flex items-center gap-x-2 rounded-lg border px-2 max-sm:flex-wrap max-sm:pb-1 ${selected ? 'border-line bg-raised' : 'border-transparent hover:bg-raised/60'}`}>
        <button
          className="flex min-h-[54px] min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent py-1.5 text-left max-sm:basis-full"
          data-testid="lesson-open"
          aria-pressed={selected}
          onClick={() => onOpen(lesson.id)}
        >
          {lesson.category === 'pastoral' ? <MapPin size={15} className="flex-none text-pv" /> : <FileText size={15} className="flex-none text-accent2" />}
          <span className="min-w-0 flex-1">
            <span className={`flex items-center gap-1.5 ${selected ? 'font-semibold' : 'font-medium'}`}>
              <span className="flex-none rounded border border-line px-1 text-[10px] font-semibold text-muted">{lesson.language === 'tl' ? 'TL' : 'EN'}</span>
              <span className="truncate max-sm:line-clamp-2 max-sm:whitespace-normal" data-testid="lesson-title"><Highlight text={lesson.title} query={query} /></span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted max-sm:line-clamp-2 max-sm:whitespace-normal" data-testid="lesson-meta">
              {meta}
              {lesson.author ? ` · By ${lesson.author}` : ''}
              {lesson.needs_check && <span className="text-warn" data-testid="lesson-not-checked"> · Not checked yet</span>}
            </span>
          </span>
          {lesson.code && <span className="hidden max-w-44 flex-none truncate rounded border border-line px-1.5 py-0.5 text-[11px] text-muted xl:block">{lesson.code}</span>}
        </button>
        <a className="icon-btn max-sm:ml-auto" href={lessonFileUrl(lesson.id, true)} download aria-label={`Download ${lesson.title}`} data-testid="lesson-download">
          <Download size={15} />
        </a>
        {/* The same dialog: a lesson not yet checked opens it to be checked against its PDF. */}
        <button
          className={`icon-btn ${lesson.needs_check ? 'text-warn' : ''}`}
          aria-label={lesson.needs_check ? `Check ${lesson.title}` : `Edit ${lesson.title}`}
          title={lesson.needs_check ? 'Not checked yet. Compare what was read with the PDF.' : undefined}
          data-testid="lesson-edit"
          data-needs-check={lesson.needs_check}
          onClick={() => setState({ editingLessonId: lesson.id })}
        >
          {lesson.needs_check ? <ClipboardCheck size={15} /> : <Pencil size={14} />}
        </button>
        <button
          className="icon-btn"
          aria-label={`Delete ${lesson.title}`}
          data-testid="lesson-delete"
          onClick={() =>
            askConfirm({
              title: 'Delete this lesson?',
              body: `"${lesson.title}" and its PDF will be removed from your vault. Its verses you have verified stay in your vault.`,
              confirmLabel: 'Delete lesson',
              onConfirm: async () => {
                await api.deleteLesson(lesson.id);
                await refreshAll();
                toast('Lesson deleted');
              },
            })
          }
        >
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
});

export function useVisibleLessons() {
  const lessons = useStore((s) => s.lessons);
  const filters = useStore((s) => s.filters);
  const contentMatches = useStore((s) => s.contentMatches);
  const sort = useStore((s) => s.sort);
  return useMemo(() => {
    const pool = lessons.filter((l) => matchesFilters(l, filters, contentMatches, true));
    const visible = sortLessons(filters.category === 'all' ? pool : pool.filter((l) => l.category === filters.category), sort);
    return { pool, visible };
  }, [lessons, filters, contentMatches, sort]);
}

export function LessonRows({ visible, onOpen, empty }: { visible: Lesson[]; onOpen: (id: string) => void; empty: React.ReactNode }) {
  const selectedId = useStore((s) => s.selectedId);
  const query = useStore((s) => s.filters.query);
  const shown = useProgressive(visible, 50);
  if (visible.length === 0) return <>{empty}</>;
  return (
    <ul className="m-0 list-none space-y-1 p-0" data-testid="lesson-list">
      {shown.map((l) => (
        <Row key={l.id} lesson={l} selected={l.id === selectedId} query={query} onOpen={onOpen} />
      ))}
    </ul>
  );
}

export { selectLesson, categoryLabel };
