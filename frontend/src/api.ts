export type Category = 'midweek' | 'weekend' | 'pastoral';
export type Language = 'en' | 'tl';

export interface Lesson {
  id: string;
  title: string;
  category: Category;
  language: Language;
  lesson_date: string | null;
  date_label: string;
  year: number | null;
  location: string;
  author: string;
  code: string;
  file_name: string;
  byte_size: number;
  page_count: number;
  source_kind: 'text' | 'ocr';
  issue: string;
  objectives: string[];
  created_at: string;
  folder_id: string | null;
  verse_keys: string[];
  /** Added by upload and not yet compared with its PDF by the user. */
  needs_check: boolean;
}

export interface Verse {
  id: string;
  canonical_key: string;
  book_id: number;
  ref_printed: string;
  ref_en: string;
  ref_tl: string;
  version: string;
  language: Language;
  text: string;
  ocr_raw: string;
  status: 'unverified' | 'verified';
  ref_note: string;
  verified_at: string | null;
  /** Where it is printed in each lesson: the part of the lesson (see partName) and the question it answers. */
  sources: { lesson_id: string; page: number; section: number; question: string; pastoral: boolean }[];
  /** Where an imported verse came from, such as "Translations.xlsx, row 17". Empty otherwise. */
  import_source: string;
}

export interface Lecture {
  id: string;
  title: string;
  issue: string;
  objective: string;
  created_at: string;
  updated_at: string;
  verse_ids: string[];
  verse_objectives: string[];
}

/** Where a PDF is uploaded: the Lesson Library or Pastoral Visits. */
export type UploadTarget = 'lesson' | 'pastoral';

export interface Suggestion {
  canonical_key: string;
  ref_en: string;
  ref_tl: string;
  score: number;
  matched_terms: string[];
  verse_ids: string[];
  meaning: boolean;
  /** The lessons, and the part of each, where it was found for this objective or topic. */
  from_lessons: LessonMatch[];
}

export interface LessonMatch {
  lesson_id: string;
  title: string;
  file_name: string;
  section: number;
  objective: string;
  question: string;
  /** Found in a pastoral visit, whose verses belong to the Verse Library. */
  pastoral: boolean;
}

export interface VerseContext {
  speaker: string;
  /** A note the user wrote about this verse. The AI writes chapter and book context instead. */
  context: string;
  reviewed: boolean;
}

/** Background on a whole chapter or book, shared by all its verses. */
export interface ScriptureContext {
  context: string;
  reviewed: boolean;
}

/** A context's Tagalog wording. Reviewed separately from its English. */
export interface TagalogContext {
  text: string;
  reviewed: boolean;
}

export interface ImportReport {
  file: string;
  committed: boolean;
  rows: number;
  new_verses: number;
  already_in_vault: number;
  duplicates_in_file: number;
  other_wordings: number;
  tagalog: number;
  english: number;
  translations: string[];
  book_fixes: { from: string; to: string; count: number }[];
  translation_fixes: { from: string; to: string; count: number }[];
  problems: { row: number; message: string }[];
  flagged: { row: number; message: string }[];
  number_fixes: { row: number; message: string }[];
}

export interface RowToFix {
  id: string;
  source: string;
  row: number;
  translation: string;
  book: string;
  chapter: string;
  verse: string;
  content: string;
  message: string;
  choices: string[];
}

export type RowCorrection = Pick<RowToFix, 'translation' | 'book' | 'chapter' | 'verse' | 'content'>;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Downloads a generated file without leaving the page. */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function fetchFile(path: string, body: unknown, fallbackName: string) {
  let res: Response;
  try {
    res = await fetch(path, json('POST', body));
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
  }
  if (!res.ok) {
    const failure = await res.json().catch(() => null);
    throw new ApiError(failure?.error ?? `Request failed (${res.status}).`, res.status);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  return { blob: await res.blob(), name };
}

/** A model download started from Settings, or the last one that ended. */
export interface ModelPull {
  model: string;
  step: number;
  steps: number;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error: string | null;
}

export interface AiStatus {
  available: boolean;
  reachable: boolean;
  model: string;
  meaning: boolean;
  embed_model: string;
  pull: ModelPull | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? `Request failed (${res.status}).`, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  lessons: () => request<Lesson[]>('/lessons'),
  /** A pastoral visit is uploaded on its own page, and is always filed as one. */
  uploadLesson: (file: File, pages: string[], sourceKind: 'text' | 'ocr', target: UploadTarget = 'lesson') => {
    const form = new FormData();
    form.set('source_kind', sourceKind);
    if (target === 'pastoral') form.set('category', 'pastoral');
    form.set('pages', JSON.stringify(pages));
    form.set('file', file, file.name);
    return request<{ lesson: Lesson; verse_count: number; unread: { page: number; text: string }[] }>('/lessons', { method: 'POST', body: form });
  },
  patchLesson: (id: string, patch: Record<string, string | string[] | boolean>) => request<Lesson>(`/lessons/${id}`, json('PATCH', patch)),
  deleteLesson: (id: string) => request(`/lessons/${id}`, { method: 'DELETE' }),
  removeLessonVerse: (id: string, verseId: string) => request(`/lessons/${id}/verses/${verseId}`, { method: 'DELETE' }),
  search: (q: string) => request<{ lesson_ids: string[] }>(`/search?q=${encodeURIComponent(q)}`),


  verses: () => request<Verse[]>('/verses'),
  correctVerse: (id: string, patch: { text?: string; reference?: string }) => request<Verse>(`/verses/${id}`, json('PATCH', patch)),
  verifyVerse: (id: string) => request<Verse>(`/verses/${id}/verify`, { method: 'POST' }),
  importVerses: (file: File, commit: boolean) => {
    const form = new FormData();
    if (commit) form.set('commit', '1');
    form.set('file', file, file.name);
    return request<ImportReport>('/verses/import', { method: 'POST', body: form });
  },
  rowsToFix: () => request<RowToFix[]>('/verses/import/rows'),
  fixRow: (id: string, row: RowCorrection) => request<RowToFix[]>(`/verses/import/rows/${id}`, json('POST', row)),
  dismissRow: (id: string) => request<RowToFix[]>(`/verses/import/rows/${id}`, { method: 'DELETE' }),
  removeImported: () => request<{ removed: number; kept: number }>('/verses/import', { method: 'DELETE' }),
  contextTagalog: () => request<Record<string, TagalogContext>>('/context-tagalog'),
  saveContextTagalog: (item: string, text: string) => request<Record<string, TagalogContext>>('/context-tagalog', json('POST', { item, text })),
  translateContext: (item: string) => request<{ available: boolean; tagalog: Record<string, TagalogContext> }>('/ai/translate', json('POST', { item })),
  translateText: (text: string) => request<{ available: boolean; text: string | null }>('/ai/translate-text', json('POST', { text })),
  verseContexts: () => request<Record<string, VerseContext>>('/verse-context'),
  saveVerseContext: (canonical_key: string, speaker: string, context: string) =>
    request<Record<string, VerseContext>>('/verse-context', json('POST', { canonical_key, speaker, context })),
  scriptureContexts: () => request<Record<string, ScriptureContext>>('/scripture-context'),
  saveScriptureContext: (scope: string, context: string) => request<Record<string, ScriptureContext>>('/scripture-context', json('POST', { scope, context })),
  searchMeaning: (q: string) => request<{ available: boolean; keys: string[] }>(`/search/meaning?q=${encodeURIComponent(q)}`),
  status: () => request<{ last_backup_at: string | null }>('/status'),

  aiStatus: () => request<AiStatus>('/ai/status'),
  /** Has Ollama download and install whichever of the app's models it does not have yet. */
  aiInstall: () => request<{ pull: ModelPull | null }>('/ai/pull', { method: 'POST' }),
  aiInstallProgress: () => request<{ pull: ModelPull | null }>('/ai/pull'),
  aiCancelInstall: () => request<{ pull: ModelPull | null }>('/ai/pull', { method: 'DELETE' }),
  /** `exclude` leaves out verses already shown, by canonical key, to suggest more. */
  aiSuggest: (issue: string, objective: string, count?: number, exclude: string[] = []) =>
    request<{ log_id: string; suggestions: Suggestion[]; meaning: boolean }>('/ai/suggest', json('POST', { issue, objective, count, exclude })),
  aiNotes: (logId: string) =>
    request<{ available: boolean; notes: Record<string, string>; context: Record<string, VerseContext>; scripture: Record<string, ScriptureContext>; model?: string }>('/ai/notes', json('POST', { log_id: logId })),

  lectures: () => request<Lecture[]>('/lectures'),
  saveLecture: (l: { id?: string; title: string; issue: string; objective: string; verse_ids: string[]; verse_objectives: string[] }) =>
    request<Lecture>('/lectures', json('POST', l)),
  exportLecture: (l: { title: string; issue: string; objective: string; verse_ids: string[]; verse_objectives: string[]; context_language: Language }) =>
    fetchFile('/api/lectures/export', l, 'lecture.docx'),
  deleteLecture: (id: string) => request(`/lectures/${id}`, { method: 'DELETE' }),

  backup: (passphrase: string) => fetchFile('/api/backup', { passphrase }, 'lesson-vault-backup.lvbackup'),
  restore: (file: File, passphrase: string) => {
    const form = new FormData();
    form.set('passphrase', passphrase);
    form.set('file', file, file.name);
    return request<{ lessons: number }>('/restore', { method: 'POST', body: form });
  },
  reset: () => request('/reset', json('POST', { confirm: 'RESET' })),
};

export const lessonFileUrl = (id: string, download = false) => `/api/lessons/${id}/file${download ? '?download=1' : ''}`;
