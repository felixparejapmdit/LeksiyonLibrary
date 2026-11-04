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
  sources: { lesson_id: string; page: number }[];
}

export interface Folder {
  id: string;
  name: string;
}

export interface Lecture {
  id: string;
  title: string;
  issue: string;
  objective: string;
  created_at: string;
  updated_at: string;
  verse_ids: string[];
}

export interface Suggestion {
  canonical_key: string;
  ref_en: string;
  ref_tl: string;
  score: number;
  matched_terms: string[];
  verse_ids: string[];
}

export interface VerseContext {
  speaker: string;
  context: string;
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

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  lessons: () => request<Lesson[]>('/lessons'),
  uploadLesson: (file: File, pages: string[], sourceKind: 'text' | 'ocr') => {
    const form = new FormData();
    form.set('source_kind', sourceKind);
    form.set('pages', JSON.stringify(pages));
    form.set('file', file, file.name);
    return request<{ lesson: Lesson; verse_count: number }>('/lessons', { method: 'POST', body: form });
  },
  patchLesson: (id: string, patch: Record<string, string | string[]>) => request<Lesson>(`/lessons/${id}`, json('PATCH', patch)),
  deleteLesson: (id: string) => request(`/lessons/${id}`, { method: 'DELETE' }),
  search: (q: string) => request<{ lesson_ids: string[] }>(`/search?q=${encodeURIComponent(q)}`),

  folders: () => request<Folder[]>('/folders'),
  createFolder: (name: string) => request<Folder>('/folders', json('POST', { name })),
  deleteFolder: (id: string) => request(`/folders/${id}`, { method: 'DELETE' }),

  verses: () => request<Verse[]>('/verses'),
  correctVerse: (id: string, patch: { text?: string; reference?: string }) => request<Verse>(`/verses/${id}`, json('PATCH', patch)),
  verifyVerse: (id: string) => request<Verse>(`/verses/${id}/verify`, { method: 'POST' }),
  verseContexts: () => request<Record<string, VerseContext>>('/verse-context'),

  aiStatus: () => request<{ available: boolean; reachable: boolean; model: string }>('/ai/status'),
  aiSuggest: (issue: string, objective: string, count?: number) =>
    request<{ log_id: string; suggestions: Suggestion[] }>('/ai/suggest', json('POST', { issue, objective, count })),
  aiNotes: (logId: string) =>
    request<{ available: boolean; notes: Record<string, string>; context: Record<string, VerseContext>; model?: string }>('/ai/notes', json('POST', { log_id: logId })),

  lectures: () => request<Lecture[]>('/lectures'),
  saveLecture: (l: { id?: string; title: string; issue: string; objective: string; verse_ids: string[] }) =>
    request<Lecture>('/lectures', json('POST', l)),
  deleteLecture: (id: string) => request(`/lectures/${id}`, { method: 'DELETE' }),

  backup: async (passphrase: string) => {
    let res: Response;
    try {
      res = await fetch('/api/backup', json('POST', { passphrase }));
    } catch {
      throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiError(body?.error ?? `Request failed (${res.status}).`, res.status);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'lesson-vault-backup.lvbackup';
    return { blob: await res.blob(), name };
  },
  restore: (file: File, passphrase: string) => {
    const form = new FormData();
    form.set('passphrase', passphrase);
    form.set('file', file, file.name);
    return request<{ lessons: number }>('/restore', { method: 'POST', body: form });
  },
  reset: () => request('/reset', json('POST', { confirm: 'RESET' })),
};

export const lessonFileUrl = (id: string, download = false) => `/api/lessons/${id}/file${download ? '?download=1' : ''}`;
