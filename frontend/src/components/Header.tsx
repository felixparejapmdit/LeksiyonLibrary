import { useRef } from 'react';
import { BookOpen, Download, Moon, PanelLeft, RotateCcw, Search, Settings, Sun, Upload, UploadCloud, X } from 'lucide-react';
import { api } from '../api';
import { forgetDocuments } from '../pdf';
import {
  askConfirm,
  errorText,
  getState,
  matchesFilters,
  navigate,
  refreshAll,
  resetFilters,
  setPanelPref,
  setQuery,
  setState,
  setTheme,
  toast,
  useRoute,
  useStore,
} from '../store';

export function restoreFromFile(file: File) {
  askConfirm({
    title: 'Restore this backup?',
    body: `Everything currently in your vault will be replaced by the contents of "${file.name}".`,
    confirmLabel: 'Replace and restore',
    // Backups made before encryption are plain zip files and have no passphrase.
    askPassphrase: !/\.zip$/i.test(file.name),
    onConfirm: async (passphrase) => {
      const { lessons } = await api.restore(file, passphrase);
      forgetDocuments();
      resetFilters();
      await refreshAll();
      toast(`Backup restored: ${lessons} ${lessons === 1 ? 'lesson' : 'lessons'}`);
    },
  });
}

export function askReset() {
  askConfirm({
    title: 'Reset your vault?',
    body: 'This permanently deletes all your lessons, verses, folders and lectures. Download a backup first if you may need them.',
    confirmLabel: 'Delete everything',
    requireText: 'RESET',
    onConfirm: async () => {
      await api.reset();
      forgetDocuments();
      resetFilters();
      await refreshAll();
      toast('Your vault has been reset');
    },
  });
}

export function RestoreInput({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept=".lvbackup,.zip,application/octet-stream,application/zip"
      className="hidden"
      data-testid="restore-input"
      aria-label="Backup file to restore"
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) restoreFromFile(f);
      }}
    />
  );
}

function SearchBox() {
  const query = useStore((s) => s.filters.query);
  const route = useRoute();
  const count = useStore((s) => (s.filters.query.trim() ? s.lessons.filter((l) => matchesFilters(l, { ...s.filters, category: 'all', year: null, folderId: null, verseKey: null, toCheck: false }, s.contentMatches)).length : 0));
  const total = useStore((s) => s.lessons.length);
  return (
    <div className="relative mx-4 hidden w-full max-w-md lg:block">
      <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
      <input
        className="field !min-h-[34px] !py-1 !pr-9 !pl-9 !text-[13px]"
        placeholder="Search lessons, verses, places"
        aria-label="Search lessons"
        data-testid="search-input"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (route !== '/') navigate('/');
        }}
      />
      {query && (
        <>
          <button className="icon-btn absolute top-0 right-0 !h-[34px] !w-[34px]" aria-label="Clear search" data-testid="search-clear" onClick={() => setQuery('')}>
            <X size={14} />
          </button>
          <div className="absolute top-full left-0 z-20 mt-1 rounded-md border border-line bg-raised px-2 py-0.5 text-xs text-muted" data-testid="search-count">
            Found {count} of {total} {total === 1 ? 'lesson' : 'lessons'}
          </div>
        </>
      )}
    </div>
  );
}

export function Header() {
  const theme = useStore((s) => s.theme);
  const route = useRoute();
  const restoreRef = useRef<HTMLInputElement>(null);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const uploading = useStore((s) => s.uploads.filter((u) => u.status === 'working' || u.status === 'queued').length);

  return (
    <header className="no-print flex h-12 flex-none items-center gap-1.5 border-b border-line bg-panel px-3" data-testid="header">
      <button
        className="icon-btn hidden lg:inline-flex"
        aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        aria-pressed={sidebarOpen}
        data-testid="toggle-sidebar"
        onClick={() => setPanelPref('sidebarOpen', !sidebarOpen)}
      >
        <PanelLeft size={16} />
      </button>
      <button
        className="tap flex items-center gap-2 rounded-md py-1 pr-2 font-semibold max-lg:min-h-11"
        data-testid="brand"
        aria-label="Lesson Vault home"
        onClick={() => navigate('/')}
      >
        <BookOpen size={18} className="text-accent" />
        <span className="whitespace-nowrap">Lesson Vault</span>
      </button>
      <div className="flex min-w-0 flex-1 justify-center">
        <SearchBox />
      </div>
      <RestoreInput inputRef={restoreRef} />
      <div className="hidden items-center gap-1.5 xl:flex">
        <button className="btn" data-testid="header-backup" onClick={() => setState({ backupOpen: true })}>
          <Download size={14} /> Backup
        </button>
        <button className="btn" data-testid="header-restore" onClick={() => restoreRef.current?.click()}>
          <Upload size={14} /> Restore
        </button>
        <button className="btn" data-testid="header-reset" onClick={askReset}>
          <RotateCcw size={14} /> Reset
        </button>
      </div>
      <button className="btn btn-primary" data-testid="header-upload" aria-label="Upload PDF" onClick={() => setState({ uploadOpen: true })}>
        <UploadCloud size={15} />
        <span className="hidden sm:inline">{uploading ? `Processing ${uploading}` : 'Upload PDF'}</span>
      </button>
      <button
        className="icon-btn hidden lg:inline-flex"
        aria-label="Settings"
        aria-current={route === '/settings' ? 'page' : undefined}
        data-testid="header-settings"
        onClick={() => navigate('/settings')}
      >
        <Settings size={16} />
      </button>
      <button
        className="icon-btn"
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        data-testid="theme-toggle"
        onClick={() => setTheme(getState().theme === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </header>
  );
}

export { errorText };
