import { useMemo, useState, type ReactNode } from 'react';
import { Archive, BookMarked, BookOpen, BookText, ChevronDown, ChevronRight, ClipboardCheck, FileSpreadsheet, Folder, FolderOpen, ListChecks, Lock, MapPin, Sparkles, type LucideIcon } from 'lucide-react';
import type { Lesson } from '../api';
import { libraryOf, navigate, openScope, selectLesson, setState, sortLessons, updateFilters, useRoute, useStore, type Scope } from '../store';

/** Each part of the library has its own colour, shared by its icon, its label and its count. */
type Tone = 'archive' | 'lessons' | 'pv' | 'assist' | 'review' | 'warn';

function Count({ n, testId, title }: { n: number; testId?: string; title?: string }) {
  return (
    <span className="nav-count" data-testid={testId} title={title}>
      {n}
    </span>
  );
}

/** A main entry: a tinted icon tile, the label and its count, all in the entry's colour. */
function Entry({ tone, icon: Icon, label, active, count, testId, title, onClick }: { tone: Tone; icon: LucideIcon; label: string; active: boolean; count?: ReactNode; testId: string; title?: string; onClick: () => void }) {
  return (
    <button className={`nav-row tone-${tone} ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined} data-testid={testId} title={title} onClick={onClick}>
      <span className="nav-tile">
        <Icon size={15} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count}
    </button>
  );
}

/** An entry inside a section, such as a year folder or a page of that library. */
function SubEntry({ tone, icon: Icon, label, active, count, testId, title, onClick }: { tone: Tone; icon: LucideIcon; label: string; active: boolean; count?: ReactNode; testId: string; title?: string; onClick: () => void }) {
  return (
    <button className={`nav-row nav-sub tone-${tone} ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined} data-testid={testId} title={title} onClick={onClick}>
      <Icon size={14} className="flex-none" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count}
    </button>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="m-0 px-2 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">{children}</h2>;
}

/**
 * Year folders, made from each lesson's date. A Lesson Library year holds only its lessons,
 * and a Pastoral Visits year only its visits. A folder opens to list what is in it.
 */
function YearFolders({ scope, lessons, tone, prefix }: { scope: Exclude<Scope, 'all'>; lessons: Lesson[]; tone: Tone; prefix: string }) {
  const route = useRoute();
  const f = useStore((s) => s.filters);
  const sort = useStore((s) => s.sort);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const years = useMemo(() => {
    const m = new Map<number, Lesson[]>();
    for (const l of lessons) if (l.year) m.set(l.year, [...(m.get(l.year) ?? []), l]);
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [lessons]);
  if (years.length === 0)
    return (
      <p className="m-0 px-2 py-1 text-[11.5px] text-muted" data-testid={`${prefix}folders-empty`}>
        Year folders appear here as {scope === 'lessons' ? 'lessons' : 'visits'} with a date are added.
      </p>
    );

  const showYear = (year: number | null) => {
    openScope(scope);
    updateFilters({ year });
  };
  return (
    <ul className="m-0 list-none p-0" data-testid={`${prefix}folders`} aria-label={`${scope === 'lessons' ? 'Lesson Library' : 'Pastoral Visits'} by year`}>
      {years.map(([year, list]) => {
        const active = route === '/' && f.scope === scope && f.year === year;
        const expanded = !!open[year];
        return (
          <li key={year}>
            <div className="flex items-center">
              <button
                className={`nav-chevron tone-${tone}`}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${year}`}
                aria-expanded={expanded}
                data-testid={`${prefix}year-expand-${year}`}
                onClick={() => setOpen((o) => ({ ...o, [year]: !expanded }))}
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <SubEntry tone={tone} icon={expanded || active ? FolderOpen : Folder} label={String(year)} active={active} count={<Count n={list.length} />} testId={`${prefix}year-${year}`} onClick={() => showYear(active ? null : year)} />
            </div>
            {expanded && (
              <ul className={`nav-tree tone-${tone}`}>
                {sortLessons(list, sort).map((l) => (
                  <li key={l.id}>
                    <button
                      className="nav-row nav-leaf"
                      data-testid="tree-lesson"
                      title={l.title}
                      onClick={() => {
                        showYear(year);
                        selectLesson(l.id);
                        setState({ drawerOpen: false });
                      }}
                    >
                      <span className="truncate">{l.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function Sidebar() {
  const route = useRoute();
  const lessons = useStore((s) => s.lessons);
  const verses = useStore((s) => s.verses);
  const rowsToFix = useStore((s) => s.rowsToFix.length);
  const f = useStore((s) => s.filters);

  const { worship, visits } = useMemo(() => ({ worship: lessons.filter((l) => l.category !== 'pastoral'), visits: lessons.filter((l) => l.category === 'pastoral') }), [lessons]);

  // Every count here is of verses, so each library is always its unverified plus its verified.
  const counts = useMemo(() => {
    const c = { verse: 0, lesson: 0, verseToReview: 0, lessonToReview: 0 };
    for (const v of verses) {
      const library = libraryOf(v);
      c[library]++;
      if (v.status === 'unverified') c[library === 'verse' ? 'verseToReview' : 'lessonToReview']++;
    }
    return c;
  }, [verses]);
  const unverified = counts.verseToReview + counts.lessonToReview;
  const verified = verses.length - unverified;
  const toCheck = useMemo(() => lessons.filter((l) => l.needs_check).length, [lessons]);

  const plain = route === '/' && f.category === 'all' && f.year === null && !f.verseKey && !f.query && !f.toCheck;
  const go = (path: string) => {
    navigate(path);
    setState({ drawerOpen: false });
  };

  return (
    <nav className="flex h-full min-w-0 flex-col overflow-hidden bg-panel" aria-label="Library" data-testid="sidebar">
      <div className="scroll-stable min-h-0 flex-1 px-2 pb-3">
        <Heading>Library</Heading>
        <Entry tone="archive" icon={Archive} label="All Archives" active={plain && f.scope === 'all'} testId="side-all" title="Every lesson: worship service lessons and pastoral visits" onClick={() => openScope('all')} count={<Count n={lessons.length} testId="side-all-count" />} />
        {toCheck > 0 && (
          <div className="nav-group tone-warn">
            <SubEntry
              tone="warn"
              icon={ClipboardCheck}
              label="Not checked yet"
              active={route === '/' && f.toCheck}
              testId="side-to-check"
              onClick={() => {
                openScope('all');
                updateFilters({ toCheck: true });
              }}
              count={<Count n={toCheck} testId="side-to-check-count" />}
            />
          </div>
        )}

        <div className="mt-1">
          <Entry tone="lessons" icon={BookOpen} label="Lesson Library" active={plain && f.scope === 'lessons'} testId="side-lessons" title="Worship service lessons uploaded as PDFs" onClick={() => openScope('lessons')} count={<Count n={worship.length} testId="side-lessons-count" />} />
          <div className="nav-group tone-lessons">
            <YearFolders scope="lessons" lessons={worship} tone="lessons" prefix="" />
            <SubEntry
              tone="lessons"
              icon={BookText}
              label="Verses from lessons"
              active={route === '/lesson-verses'}
              testId="side-lesson-verses"
              onClick={() => go('/lesson-verses')}
              count={<Count n={counts.lesson} testId="side-lesson-verses-count" title={`${counts.lesson} verses read from lesson PDFs: ${counts.lesson - counts.lessonToReview} verified, ${counts.lessonToReview} to review`} />}
            />
          </div>
        </div>

        <div className="mt-1">
          <Entry tone="pv" icon={MapPin} label="Pastoral Visits" active={plain && f.scope === 'pastoral'} testId="side-pv" title="Pastoral visits, with their own upload" onClick={() => openScope('pastoral')} count={<Count n={visits.length} testId="side-pv-count" />} />
          <div className="nav-group tone-pv">
            <YearFolders scope="pastoral" lessons={visits} tone="pv" prefix="pv-" />
            <SubEntry
              tone="pv"
              icon={BookMarked}
              label="Verse Library"
              active={route === '/bibles'}
              testId="side-bibles"
              title="Verses read from pastoral visit PDFs and imported from Excel files"
              onClick={() => go('/bibles')}
              count={<Count n={counts.verse} testId="side-bibles-count" title={`${counts.verse} verses: ${counts.verse - counts.verseToReview} verified, ${counts.verseToReview} to review`} />}
            />
            <SubEntry
              tone="pv"
              icon={FileSpreadsheet}
              label="Import Verses"
              active={route === '/import'}
              testId="side-import"
              title="Import verses from an Excel file into the Verse Library"
              onClick={() => go('/import')}
              count={rowsToFix > 0 ? <Count n={rowsToFix} testId="side-import-count" title={`${rowsToFix} imported ${rowsToFix === 1 ? 'row' : 'rows'} to fix`} /> : undefined}
            />
          </div>
        </div>

        <Heading>Tools</Heading>
        <Entry tone="assist" icon={Sparkles} label="Lesson Assistant" active={route === '/lecture'} testId="side-lecture" title="Lecture Maker: builds a lecture from the verses in both libraries" onClick={() => go('/lecture')} />
        <div className="mt-0.5">
          <Entry
            tone="review"
            icon={ListChecks}
            label="Review Verses"
            active={route === '/review'}
            testId="side-review"
            onClick={() => go('/review')}
            count={<Count n={unverified} testId="side-review-count" title={`${unverified} of ${verses.length} verses still to review: ${counts.verseToReview} in the Verse Library, ${counts.lessonToReview} in the Lesson Library`} />}
          />
        </div>
      </div>

      {/* How far checking has come, and a reminder of where the vault lives. */}
      <div className="flex-none border-t border-line p-3" data-testid="side-footer">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="font-medium">Verified verses</span>
          <span className="text-muted tabular-nums" data-testid="side-verified">
            {verified} of {verses.length}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised" role="progressbar" aria-label="Verified verses" aria-valuemin={0} aria-valuemax={verses.length} aria-valuenow={verified}>
          <div className="nav-progress h-full rounded-full" style={{ width: `${verses.length ? (verified / verses.length) * 100 : 0}%` }} />
        </div>
        <p className="m-0 mt-2 flex items-center gap-1.5 text-[11px] text-muted">
          <Lock size={11} className="flex-none" /> Encrypted, and kept on this computer only
        </p>
      </div>
    </nav>
  );
}
