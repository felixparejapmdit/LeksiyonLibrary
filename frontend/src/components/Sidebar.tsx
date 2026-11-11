import { useMemo, useState, type ReactNode } from 'react';
import { Archive, BookMarked, BookOpen, BookText, ChevronDown, ChevronRight, ClipboardCheck, FileSpreadsheet, Folder, FolderOpen, ListChecks, Lock, MapPin, Sparkles, type LucideIcon } from 'lucide-react';
import type { Language, Lesson } from '../api';
import { libraryOf, navigate, openLesson, openScope, setState, sortLessons, updateFilters, useRoute, useStore, type Scope } from '../store';

/** Section colors identify icons and counts while the labels follow the reading theme. */
type Tone = 'archive' | 'lessons' | 'pv' | 'assist' | 'review' | 'warn';

function Count({ n, testId, title }: { n: number; testId?: string; title?: string }) {
  return (
    <span className="nav-count" data-testid={testId} title={title}>
      {n}
    </span>
  );
}

/** A main entry: a tinted icon tile and count beside a readable neutral label. */
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
      <Icon size={14} className="nav-section-icon flex-none" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count}
    </button>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="sidebar-heading">{children}</h2>;
}

/**
 * Year folders, made from each lesson's date. A Lesson Library year holds only its lessons,
 * and a Pastoral Visits year only its visits. A folder opens to list what is in it.
 */
function YearFolders({ scope, lessons, tone, prefix }: { scope: Exclude<Scope, 'all'>; lessons: Lesson[]; tone: Tone; prefix: string }) {
  const route = useRoute();
  const f = useStore((s) => s.filters);
  const sort = useStore((s) => s.sort);
  const selectedId = useStore((s) => s.selectedId);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [languageOpen, setLanguageOpen] = useState<Record<string, boolean>>({});
  const years = useMemo(() => {
    const m = new Map<number, Lesson[]>();
    for (const l of lessons) {
      const year = l.year || 0;
      m.set(year, [...(m.get(year) ?? []), l]);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [lessons]);
  if (years.length === 0)
    return (
      <p className="m-0 px-2 py-1 text-[11.5px] text-muted" data-testid={`${prefix}folders-empty`}>
        Year folders appear here as {scope === 'lessons' ? 'lessons' : 'visits'} with a date are added.
      </p>
    );

  const showYear = (year: number | null, language: 'all' | Language = 'all') => {
    openScope(scope);
    updateFilters({ year, language });
  };
  return (
    <ul className="m-0 list-none p-0" data-testid={`${prefix}folders`} aria-label={`${scope === 'lessons' ? 'Lesson Library' : 'Pastoral Visits'} by year`}>
      {years.map(([year, list]) => {
        const active = route === '/' && f.scope === scope && f.year === year;
        const expanded = !!open[year];
        const label = year === 0 ? 'No date' : String(year);
        const testYear = year === 0 ? 'none' : String(year);
        return (
          <li key={year}>
            <div className="flex items-center">
              <button
                className={`nav-chevron tone-${tone}`}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
                aria-expanded={expanded}
                data-testid={`${prefix}year-expand-${testYear}`}
                onClick={() => setOpen((o) => ({ ...o, [year]: !expanded }))}
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <SubEntry tone={tone} icon={expanded || active ? FolderOpen : Folder} label={label} active={active} count={<Count n={list.length} />} testId={`${prefix}year-${testYear}`} onClick={() => showYear(active && f.language === 'all' ? null : year)} />
            </div>
            {expanded && (
              <ul className={`nav-tree tone-${tone}`}>
                {(['tl', 'en'] as const).map((language) => {
                  const items = sortLessons(list.filter((l) => l.language === language), sort);
                  if (items.length === 0) return null;
                  const languageLabel = language === 'tl' ? 'Tagalog' : 'English';
                  const key = `${year}:${language}`;
                  const languageExpanded = languageOpen[key] !== false;
                  const languageActive = active && f.language === language;
                  return (
                    <li key={language} data-language={language}>
                      <div className="flex min-w-0 items-center">
                        <button
                          className="nav-chevron nav-language-chevron"
                          aria-label={`${languageExpanded ? 'Collapse' : 'Expand'} ${languageLabel} in ${label}`}
                          aria-expanded={languageExpanded}
                          data-testid={`${prefix}year-${testYear}-language-${language}-expand`}
                          onClick={() => setLanguageOpen((o) => ({ ...o, [key]: !languageExpanded }))}
                        >
                          {languageExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </button>
                        <button
                          className={`nav-row nav-language ${languageActive ? 'is-active' : ''}`}
                          aria-current={languageActive ? 'page' : undefined}
                          aria-label={`Show ${languageLabel} ${scope === 'lessons' ? 'lessons' : 'visits'} in ${label}`}
                          data-testid={`${prefix}year-${testYear}-language-${language}`}
                          onClick={() => showYear(year, language)}
                        >
                          <span className="min-w-0 flex-1 truncate">{languageLabel}</span>
                          <Count n={items.length} title={`${items.length} ${languageLabel} ${items.length === 1 ? 'lesson' : 'lessons'}`} />
                        </button>
                      </div>
                      {languageExpanded && (
                        <ul className="nav-language-list" data-testid={`${prefix}year-${testYear}-${language}-lessons`}>
                          {items.map((l) => {
                            const selected = route === '/' && f.scope === scope && selectedId === l.id;
                            return (
                              <li key={l.id}>
                                <button
                                  className={`nav-row nav-leaf ${selected ? 'is-active' : ''}`}
                                  aria-current={selected ? 'page' : undefined}
                                  data-testid="tree-lesson"
                                  data-lesson-id={l.id}
                                  data-language={language}
                                  title={l.title}
                                  onClick={() => {
                                    showYear(year, language);
                                    openLesson(l.id);
                                  }}
                                >
                                  <span className="min-w-0 flex-1 truncate">{l.title}</span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
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

  const plain = route === '/' && f.category === 'all' && f.year === null && f.language === 'all' && !f.verseKey && !f.query && !f.toCheck;
  const go = (path: string) => {
    navigate(path);
    setState({ drawerOpen: false });
  };

  return (
    <nav className="sidebar-surface flex h-full min-w-0 flex-col overflow-hidden" aria-label="Library" data-testid="sidebar">
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
          <Entry tone="lessons" icon={BookOpen} label="Lesson Library" active={plain && f.scope === 'lessons'} testId="side-lessons" title="Worship service lessons uploaded as PDF or DOCX files" onClick={() => openScope('lessons')} count={<Count n={worship.length} testId="side-lessons-count" />} />
          <div className="nav-group tone-lessons">
            <YearFolders scope="lessons" lessons={worship} tone="lessons" prefix="" />
            <SubEntry
              tone="lessons"
              icon={BookText}
              label="Verses from lessons"
              active={route === '/lesson-verses'}
              testId="side-lesson-verses"
              onClick={() => go('/lesson-verses')}
              count={<Count n={counts.lesson} testId="side-lesson-verses-count" title={`${counts.lesson} verses read from lesson documents: ${counts.lesson - counts.lessonToReview} verified, ${counts.lessonToReview} to review`} />}
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
              title="Verses read from pastoral visit documents and imported from Excel files"
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
