import { useSyncExternalStore } from 'react';
import { api, ApiError, type Category, type Folder, type Lecture, type Lesson, type Verse, type VerseContext } from './api';

export type SortMode = 'newest' | 'oldest' | 'title';

export interface Filters {
  category: Category | 'all';
  year: number | null;
  folderId: string | null;
  verseKey: string | null;
  query: string;
}

export interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}

export interface UploadItem {
  id: number;
  name: string;
  status: 'queued' | 'working' | 'done' | 'error';
  message: string;
  progress: number;
}

export interface Confirmation {
  title: string;
  body: string;
  confirmLabel: string;
  requireText?: string;
  askPassphrase?: boolean;
  onConfirm: (passphrase: string) => Promise<void> | void;
}

export interface State {
  booted: boolean;
  bootError: boolean;
  lessons: Lesson[];
  verses: Verse[];
  contexts: Record<string, VerseContext>;
  folders: Folder[];
  lectures: Lecture[];
  filters: Filters;
  sort: SortMode;
  selectedId: string | null;
  viewerPage: number;
  contentMatches: string[] | null;
  sidebarOpen: boolean;
  viewerOpen: boolean;
  drawerOpen: boolean;
  uploadOpen: boolean;
  backupOpen: boolean;
  uploads: UploadItem[];
  editingLessonId: string | null;
  confirm: Confirmation | null;
  toasts: Toast[];
  theme: 'dark' | 'light';
}

const emptyFilters: Filters = { category: 'all', year: null, folderId: null, verseKey: null, query: '' };

function stored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

let state: State = {
  booted: false,
  bootError: false,
  lessons: [],
  verses: [],
  contexts: {},
  folders: [],
  lectures: [],
  filters: emptyFilters,
  sort: 'newest',
  selectedId: null,
  viewerPage: 1,
  contentMatches: null,
  sidebarOpen: stored('lv.sidebar', '1') !== '0',
  viewerOpen: stored('lv.viewer', '1') !== '0',
  drawerOpen: false,
  uploadOpen: false,
  backupOpen: false,
  uploads: [],
  editingLessonId: null,
  confirm: null,
  toasts: [],
  theme: stored('lv.theme', 'dark') === 'light' ? 'light' : 'dark',
};

const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

// ---------- Routing ----------

const routeListeners = new Set<() => void>();
window.addEventListener('popstate', () => routeListeners.forEach((l) => l()));

export function navigate(path: string) {
  if (location.pathname !== path) history.pushState(null, '', path);
  setState({ drawerOpen: false });
  routeListeners.forEach((l) => l());
}

export function useRoute() {
  return useSyncExternalStore(
    (cb) => {
      routeListeners.add(cb);
      return () => routeListeners.delete(cb);
    },
    () => location.pathname,
  );
}

// ---------- Actions ----------

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'ok') {
  const id = ++toastId;
  setState({ toasts: [...state.toasts.slice(-3), { id, kind, text }] });
  setTimeout(() => setState({ toasts: state.toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 3500);
}

export function errorText(e: unknown) {
  return e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
}

export async function refreshAll() {
  const [lessons, verses, contexts, folders, lectures] = await Promise.all([api.lessons(), api.verses(), api.verseContexts(), api.folders(), api.lectures()]);
  const selectedStillExists = lessons.some((l) => l.id === state.selectedId);
  setState({
    lessons,
    verses,
    contexts,
    folders,
    lectures,
    selectedId: selectedStillExists ? state.selectedId : (newestFirst(lessons)[0]?.id ?? null),
    viewerPage: selectedStillExists ? state.viewerPage : 1,
  });
}

export function newestFirst(list: Lesson[]) {
  return [...list].sort((a, b) => (b.lesson_date ?? b.created_at).localeCompare(a.lesson_date ?? a.created_at));
}

export async function boot() {
  setState({ bootError: false });
  try {
    await refreshAll();
    setState({ booted: true });
  } catch {
    // Shown as an error, never as an empty vault, so saved work does not look lost.
    setState({ bootError: true });
  }
}

export function setTheme(theme: 'dark' | 'light') {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#0b0f19' : '#f8fafc');
  try {
    localStorage.setItem('lv.theme', theme);
  } catch {
    /* private mode: the theme still applies for this session */
  }
  setState({ theme });
}

export function setPanelPref(key: 'sidebarOpen' | 'viewerOpen', open: boolean) {
  try {
    localStorage.setItem(key === 'sidebarOpen' ? 'lv.sidebar' : 'lv.viewer', open ? '1' : '0');
  } catch {
    /* ignore */
  }
  setState({ [key]: open });
}

export function updateFilters(patch: Partial<Filters>) {
  setState({ filters: { ...state.filters, ...patch } });
}

export function resetFilters() {
  setState({ filters: { ...emptyFilters }, contentMatches: null });
}

export function selectLesson(id: string, page = 1) {
  setState({ selectedId: id, viewerPage: page });
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;

/** Title matches appear instantly; lesson body matches are merged in right after. */
export function setQuery(query: string) {
  updateFilters({ query });
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  if (!query.trim()) {
    setState({ contentMatches: null });
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const { lesson_ids } = await api.search(query);
      if (seq === searchSeq) setState({ contentMatches: lesson_ids });
    } catch {
      /* the instant title match stays on screen */
    }
  }, 120);
}

export function matchesFilters(l: Lesson, f: Filters, contentMatches: string[] | null, ignoreCategory = false) {
  if (!ignoreCategory && f.category !== 'all' && l.category !== f.category) return false;
  if (f.year !== null && l.year !== f.year) return false;
  if (f.folderId !== null && l.folder_id !== f.folderId) return false;
  if (f.verseKey !== null && !l.verse_keys.includes(f.verseKey)) return false;
  const q = f.query.trim().toLowerCase();
  if (q) {
    const hay = `${l.title} ${l.code} ${l.location} ${l.author} ${l.file_name}`.toLowerCase();
    const terms = q.split(/\s+/);
    if (!terms.every((t) => hay.includes(t)) && !contentMatches?.includes(l.id)) return false;
  }
  return true;
}

export function sortLessons(list: Lesson[], sort: SortMode) {
  const dateOf = (l: Lesson) => l.lesson_date ?? l.created_at;
  const sorted = [...list];
  if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'oldest') sorted.sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.title.localeCompare(b.title));
  else sorted.sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || a.title.localeCompare(b.title));
  return sorted;
}

export function askConfirm(c: Confirmation) {
  setState({ confirm: c });
}

export function verseGroups(verses: Verse[]) {
  const groups = new Map<string, Verse[]>();
  for (const v of verses) {
    const g = groups.get(v.canonical_key);
    if (g) g.push(v);
    else groups.set(v.canonical_key, [v]);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, items, book: items[0].book_id }));
}

export function formatLessonDate(l: Lesson) {
  if (l.date_label) return l.date_label;
  if (!l.lesson_date) return 'Date not set';
  const d = new Date(`${l.lesson_date}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export const categoryLabel: Record<Category, string> = {
  midweek: 'Midweek',
  weekend: 'Weekend',
  pastoral: 'Pastoral Visits',
};
