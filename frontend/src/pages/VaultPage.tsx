import { useCallback, useEffect, useState } from 'react';
import { ArrowDownUp, FolderSearch, FolderTree, MapPin, PanelRight, UploadCloud } from 'lucide-react';
import { ResizeHandle, useIsDesktop } from '../components/Layout';
import { CategoryTabs, FilterChips, LessonRows, useVisibleLessons, YearFolderTabs } from '../components/LessonList';
import { PdfViewer } from '../components/PdfViewer';
import { Sidebar } from '../components/Sidebar';
import { addPastoralVisits, PastoralDrop } from '../components/PastoralDrop';
import { categoryLabel, getState, openUpload, resetFilters, scopeTitle, selectLesson, setPanelPref, setState, updateFilters, useStore, type SortMode } from '../store';

const DESKTOP = '(min-width: 1024px)';

export function VaultPage() {
  const desktop = useIsDesktop();
  const { pool, visible } = useVisibleLessons();
  const sort = useStore((s) => s.sort);
  const category = useStore((s) => s.filters.category);
  const scope = useStore((s) => s.filters.scope);
  const total = useStore((s) => s.lessons.length);
  const selectedId = useStore((s) => s.selectedId);
  const chosen = useStore((s) => s.lessons.find((l) => l.id === s.selectedId) ?? null);
  // Pastoral Visits shows only pastoral visits, and the Lesson Library none: a lesson open from another list is not shown.
  const scopeOf = useStore((s) => s.filters.scope);
  const selected = chosen && (scopeOf === 'all' || (scopeOf === 'pastoral') === (chosen.category === 'pastoral')) ? chosen : null;
  const viewerOpen = useStore((s) => s.viewerOpen);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const [mobileViewer, setMobileViewer] = useState(false);
  // PDFs dragged anywhere over the Pastoral Visits list are taken as pastoral visits.
  const [dragging, setDragging] = useState(false);
  const pastoralPage = scope === 'pastoral';

  const onOpen = useCallback((id: string) => {
    selectLesson(id);
    if (!matchMedia(DESKTOP).matches) setMobileViewer(true);
  }, []);
  useEffect(() => {
    if (desktop) setMobileViewer(false);
  }, [desktop]);

  // Keep the viewer on a lesson the current filters still show.
  useEffect(() => {
    if (visible.length && !visible.some((l) => l.id === getState().selectedId)) selectLesson(visible[0].id);
  }, [visible]);

  const title = category === 'all' || scope === 'pastoral' ? scopeTitle[scope] : categoryLabel[category];
  const target = scope === 'pastoral' ? 'pastoral' : 'lesson';

  const emptyState =
    total === 0 ? (
      <div className="flex flex-col items-center px-4 py-16 text-center" data-testid="empty-vault">
        <UploadCloud size={32} className="text-accent2" />
        <h2 className="m-0 mt-3 text-base font-semibold">Your vault is empty</h2>
        <p className="m-0 mt-1 mb-4 max-w-xs text-[13px] text-muted">{scope === 'pastoral' ? 'Upload a pastoral visit PDF to collect its verses in the Verse Library.' : 'Upload a lesson PDF to index the lesson and collect its verses.'}</p>
        <button className="btn btn-primary" data-testid="empty-upload" onClick={() => openUpload(target)}>Upload PDF</button>
      </div>
    ) : pool.length === 0 && scope === 'pastoral' && category === 'all' ? (
      <div className="flex flex-col items-center px-4 py-16 text-center" data-testid="empty-pastoral">
        <MapPin size={30} className="text-pv" />
        <h2 className="m-0 mt-3 text-base font-semibold">No pastoral visits yet</h2>
        <p className="m-0 mt-1 mb-4 max-w-xs text-[13px] text-muted">Drop pastoral visit PDFs above, as many as you like. Their verses go to the Verse Library.</p>
      </div>
    ) : (
      <div className="flex flex-col items-center px-4 py-16 text-center" data-testid="empty-filter">
        <FolderSearch size={30} className="text-muted" />
        <h2 className="m-0 mt-3 text-base font-semibold">No lessons match</h2>
        <button
          className="btn mt-3"
          data-testid="empty-reset"
          onClick={() => {
            // Clears the filters, staying in the list that is open.
            resetFilters();
            updateFilters({ scope });
          }}
        >
          Reset Filters
        </button>
      </div>
    );

  const listPane = (
    <section
      className="flex h-full min-w-0 flex-1 flex-col bg-bg"
      aria-label="Lessons"
      data-testid="list-pane"
      onDragOver={(e) => {
        if (!pastoralPage || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!pastoralPage) return;
        e.preventDefault();
        setDragging(false);
        addPastoralVisits(e.dataTransfer.files);
      }}
    >
      <div className="flex-none px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          {!desktop && (
            <button className="icon-btn" aria-label="Open the library menu" data-testid="open-drawer" onClick={() => setState({ drawerOpen: true })}>
              <FolderTree size={18} />
            </button>
          )}
          <h1 className="m-0 min-w-0 truncate text-lg font-semibold" data-testid="list-title">{title}</h1>
          {scope === 'lessons' && (
            <button className="btn btn-primary !min-h-[34px] max-lg:!min-h-11" data-testid="lesson-upload" aria-label="Upload PDF" onClick={() => openUpload('lesson')}>
              <UploadCloud size={14} /> <span className="max-sm:sr-only">Upload PDF</span>
            </button>
          )}
          <label className="ml-auto flex items-center gap-1 text-muted">
            <ArrowDownUp size={13} />
            <span className="sr-only">Sort lessons</span>
            <select
              className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11"
              data-testid="sort-select"
              value={sort}
              onChange={(e) => setState({ sort: e.target.value as SortMode })}
            >
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
              <option value="title">Title A-Z</option>
            </select>
          </label>
          {desktop && (
            <button className="icon-btn" aria-label={viewerOpen ? 'Hide PDF viewer' : 'Show PDF viewer'} data-testid="toggle-viewer" aria-pressed={viewerOpen} onClick={() => setPanelPref('viewerOpen', !viewerOpen)}>
              <PanelRight size={16} />
            </button>
          )}
        </div>
        {pastoralPage && <PastoralDrop dragging={dragging} />}
        <div className="mt-2">{pastoralPage ? <YearFolderTabs /> : <CategoryTabs pool={pool} />}</div>
        <FilterChips />
        <div className="mt-1.5 flex justify-between border-b border-line pb-1 text-xs text-muted">
          <span>Name</span>
          <span data-testid="item-count">{visible.length} {visible.length === 1 ? 'item' : 'items'}</span>
        </div>
      </div>
      <div className="scroll-stable min-h-0 flex-1 px-2 pb-3" data-testid="list-scroll">
        <LessonRows visible={visible} onOpen={onOpen} empty={emptyState} />
      </div>
    </section>
  );

  if (!desktop) {
    return (
      <div className="relative h-full" data-testid="vault-page">
        {listPane}
        {drawerOpen && (
          <div className="fade-in fixed inset-0 z-40 flex" data-testid="drawer">
            <div className="h-full w-[84vw] max-w-80 border-r border-line bg-panel">
              <Sidebar />
            </div>
            <button className="flex-1 border-0 bg-black/60" aria-label="Close the library menu" data-testid="drawer-close" onClick={() => setState({ drawerOpen: false })} />
          </div>
        )}
        {mobileViewer && selected && (
          <div className="absolute inset-0 z-30 bg-bg" data-testid="mobile-viewer">
            <PdfViewer lesson={selected} onBack={() => setMobileViewer(false)} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-testid="vault-page" className="flex h-full">
      {listPane}
      {viewerOpen && (
        <>
          <ResizeHandle variable="--viewer-w" storageKey="lv.viewerW" edge="right" min={320} max={1100} label="Resize PDF viewer" testId="resize-viewer" />
          <div className="min-w-0 flex-none" style={{ width: 'var(--viewer-w)', maxWidth: `calc(100vw - ${sidebarOpen ? 'var(--sidebar-w)' : '0px'} - 472px)` }}>
            {selected && selectedId ? (
              <PdfViewer lesson={selected} />
            ) : (
              <div className="flex h-full items-center justify-center border-l border-line p-6 text-center text-[13px] text-muted" data-testid="viewer-empty">
                Select a lesson to read it here.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
