import { memo, useMemo, useState } from 'react';
import { Archive, BookMarked, ChevronDown, ChevronRight, Folder, FolderPlus, ListChecks, MapPin, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useProgressive } from './Layout';
import {
  askConfirm,
  errorText,
  getState,
  navigate,
  refreshAll,
  resetFilters,
  selectLesson,
  setState,
  sortLessons,
  toast,
  updateFilters,
  useRoute,
  useStore,
  verseGroups,
} from '../store';

function Count({ n, testId, title }: { n: number; testId?: string; title?: string }) {
  return <span className="ml-auto flex-none pl-2 text-xs text-muted tabular-nums" data-testid={testId} title={title}>{n}</span>;
}

const rowClass = (active: boolean) =>
  `tap flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left text-[13px] max-lg:min-h-11 ${active ? 'bg-raised font-semibold text-fg' : 'text-fg hover:bg-raised/60'}`;

function openLesson(id: string) {
  selectLesson(id);
  setState({ drawerOpen: false });
}

function toggleVerseFilter(key: string) {
  const current = getState().filters.verseKey;
  updateFilters({ verseKey: current === key ? null : key });
  if (location.pathname !== '/') navigate('/');
  setState({ drawerOpen: false });
}

// Memoised so changing a filter re-renders only the rows whose state changed.
const VerseRow = memo(function VerseRow({ verseKey, label, count, active }: { verseKey: string; label: string; count: number; active: boolean }) {
  return (
    <li>
      <button className={rowClass(active)} data-testid="side-verse" aria-pressed={active} onClick={() => toggleVerseFilter(verseKey)}>
        <span className="truncate text-xs">{label}</span>
        <Count n={count} />
      </button>
    </li>
  );
});

export function Sidebar() {
  const route = useRoute();
  const lessons = useStore((s) => s.lessons);
  const folders = useStore((s) => s.folders);
  const verses = useStore((s) => s.verses);
  const f = useStore((s) => s.filters);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [foldersOpen, setFoldersOpen] = useState(true);
  const [versesOpen, setVersesOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  const years = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of lessons) if (l.year) m.set(l.year, (m.get(l.year) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [lessons]);

  const pastoralCount = useMemo(() => lessons.filter((l) => l.category === 'pastoral').length, [lessons]);

  const groups = useMemo(() => {
    const seen = verseGroups(verses).map((g) => ({
      key: g.key,
      label: g.items[0].ref_en,
      book: g.book,
      lessons: new Set(g.items.flatMap((v) => v.sources.map((x) => x.lesson_id))).size,
    }));
    // This list filters lessons, so verses that only came from an import have no place in it.
    return seen.filter((g) => g.lessons > 0).sort((a, b) => a.book - b.book || a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [verses]);

  const shownGroups = useProgressive(groups, 60);
  // Both counts are of verses, so the library is always unverified plus verified.
  const unverified = useMemo(() => verses.filter((v) => v.status === 'unverified').length, [verses]);

  const allActive = route === '/' && f.category === 'all' && f.year === null && !f.verseKey && !f.folderId && !f.query;

  const toggle = (k: string) => setExpanded((e) => ({ ...e, [k]: !e[k] }));
  const goVault = () => {
    if (route !== '/') navigate('/');
    setState({ drawerOpen: false });
  };

  const LessonChildren = ({ list }: { list: typeof lessons }) => (
    <ul className="m-0 mb-1 ml-5 list-none border-l border-line p-0 pl-1">
      {sortLessons(list, getState().sort).map((l) => (
        <li key={l.id}>
          <button className={rowClass(false)} data-testid="tree-lesson" onClick={() => { goVault(); openLesson(l.id); }}>
            <span className="truncate text-xs">{l.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <nav className="flex h-full min-w-0 flex-col overflow-hidden bg-panel" aria-label="Library" data-testid="sidebar">
      <div className="flex-none space-y-0.5 p-2">
        <button className={rowClass(allActive)} data-testid="side-all" onClick={() => { resetFilters(); goVault(); }}>
          <Archive size={15} className="flex-none" /> All Archives
          <Count n={lessons.length} testId="side-all-count" />
        </button>
        <button className={rowClass(route === '/bibles')} data-testid="side-bibles" onClick={() => navigate('/bibles')}>
          <BookMarked size={15} className="flex-none" /> Bibles Library
          <Count n={verses.length} testId="side-bibles-count" title={`${verses.length} verses: ${verses.length - unverified} verified, ${unverified} to review`} />
        </button>
        <button className={rowClass(route === '/lecture')} data-testid="side-lecture" onClick={() => navigate('/lecture')}>
          <Sparkles size={15} className="flex-none" /> Lecture Maker
        </button>
        <button className={rowClass(route === '/review')} data-testid="side-review" onClick={() => navigate('/review')}>
          <ListChecks size={15} className="flex-none" /> Review Verses
          <Count n={unverified} testId="side-review-count" title={`${unverified} of ${verses.length} verses still to review`} />
        </button>
      </div>
      <div className="scroll-stable min-h-0 flex-1 px-2 pb-3">
        <div className="flex items-center justify-between">
          <button className="tap flex min-h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted hover:text-fg max-lg:min-h-11" aria-expanded={foldersOpen} data-testid="folders-toggle" onClick={() => setFoldersOpen(!foldersOpen)}>
            Folders {foldersOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          <button className="icon-btn !h-8 !w-8 max-lg:!h-11 max-lg:!w-11" aria-label="New folder" data-testid="folder-add" onClick={() => { setAdding(!adding); setFoldersOpen(true); }}>
            <FolderPlus size={14} />
          </button>
        </div>
        {adding && (
          <form
            className="mb-1 flex gap-1 px-1"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.createFolder(newName);
                setNewName('');
                setAdding(false);
                await refreshAll();
              } catch (err) {
                toast(errorText(err), 'error');
              }
            }}
          >
            <input autoFocus className="field !min-h-8 !py-1 !text-[13px] max-lg:!min-h-11" placeholder="Folder name" aria-label="Folder name" data-testid="folder-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="folder-save" disabled={!newName.trim()}>Add</button>
          </form>
        )}
        {foldersOpen && (
          <ul className="m-0 list-none space-y-0.5 p-0" data-testid="folder-list">
            {years.map(([year, n]) => (
              <li key={year}>
                <div className="flex items-center">
                  <button className="icon-btn !h-8 !w-6 max-lg:!h-11 max-lg:!w-8" aria-label={`${expanded[`y${year}`] ? 'Collapse' : 'Expand'} ${year}`} aria-expanded={!!expanded[`y${year}`]} data-testid={`year-expand-${year}`} onClick={() => toggle(`y${year}`)}>
                    {expanded[`y${year}`] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <button className={rowClass(f.year === year)} data-testid={`year-${year}`} onClick={() => { updateFilters({ year: f.year === year ? null : year }); goVault(); }}>
                    <Folder size={14} className="flex-none text-accent2" /> {year}
                    <Count n={n} />
                  </button>
                </div>
                {expanded[`y${year}`] && <LessonChildren list={lessons.filter((l) => l.year === year)} />}
              </li>
            ))}
            {folders.map((fd) => (
              <li key={fd.id} className="flex items-center">
                <span className="w-6 flex-none max-lg:w-8" />
                <button className={rowClass(f.folderId === fd.id)} data-testid="custom-folder" onClick={() => { updateFilters({ folderId: f.folderId === fd.id ? null : fd.id }); goVault(); }}>
                  <Folder size={14} className="flex-none text-muted" /> <span className="truncate">{fd.name}</span>
                  <Count n={lessons.filter((l) => l.folder_id === fd.id).length} />
                </button>
                <button
                  className="icon-btn !h-8 !w-8 max-lg:!h-11 max-lg:!w-11"
                  aria-label={`Delete folder ${fd.name}`}
                  data-testid="custom-folder-delete"
                  onClick={() =>
                    askConfirm({
                      title: 'Delete this folder?',
                      body: `"${fd.name}" will be removed. The lessons inside it stay in your vault.`,
                      confirmLabel: 'Delete folder',
                      onConfirm: async () => {
                        await api.deleteFolder(fd.id);
                        if (getState().filters.folderId === fd.id) updateFilters({ folderId: null });
                        await refreshAll();
                      },
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
            <li>
              <div className="flex items-center">
                <button className="icon-btn !h-8 !w-6 max-lg:!h-11 max-lg:!w-8" aria-label={`${expanded.pv ? 'Collapse' : 'Expand'} Pastoral Visits`} aria-expanded={!!expanded.pv} data-testid="pastoral-expand" onClick={() => toggle('pv')}>
                  {expanded.pv ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <button className={rowClass(f.category === 'pastoral')} data-testid="side-pastoral" onClick={() => { updateFilters({ category: f.category === 'pastoral' ? 'all' : 'pastoral' }); goVault(); }}>
                  <MapPin size={14} className="flex-none text-pv" /> Pastoral Visits
                  <Count n={pastoralCount} testId="side-pastoral-count" />
                </button>
              </div>
              {expanded.pv && <LessonChildren list={lessons.filter((l) => l.category === 'pastoral')} />}
            </li>
          </ul>
        )}
        <div className="mt-2 flex items-center">
          <button className="tap flex min-h-8 flex-1 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted hover:text-fg max-lg:min-h-11" aria-expanded={versesOpen} data-testid="verses-toggle" onClick={() => setVersesOpen(!versesOpen)}>
            Verses {versesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Count n={groups.length} testId="side-verses-count" />
          </button>
        </div>
        {versesOpen && (
          <ul className="m-0 list-none space-y-0.5 p-0" data-testid="verse-list">
            {groups.length === 0 && <li className="px-2 py-1 text-xs text-muted">Verses appear here after you upload a lesson.</li>}
            {shownGroups.map((g) => (
              <VerseRow key={g.key} verseKey={g.key} label={g.label} count={g.lessons} active={f.verseKey === g.key} />
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
