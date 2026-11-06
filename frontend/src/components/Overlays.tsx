import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BellRing, CheckCircle2, CircleAlert, ClipboardCheck, FileUp, FolderUp, Loader2, PencilLine, Trash2, UploadCloud, X } from 'lucide-react';
import { api, saveFile, type Category, type Language, type Verse } from '../api';
import { enqueueFiles, enqueueFolder } from '../ingest';
import { askConfirm, errorText, getState, partName, refreshAll, selectLesson, setState, toast, useStore } from '../store';
import { PdfViewer } from './PdfViewer';
import { backgroundOf, ContextLanguageSwitch, scopeNames, tagalogItems } from './VerseContext';

// Dialogs can open over other dialogs. Escape closes only the one on top.
const openModals: object[] = [];

function Modal({ title, subtitle, onClose, children, testId, wide, full }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; testId: string; wide?: boolean; full?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const token = {};
    openModals.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openModals[openModals.length - 1] === token) onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      openModals.splice(openModals.indexOf(token), 1);
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  // Portalled so that containment on an ancestor can never clip the dialog.
  return createPortal(
    <div
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3"
      data-testid={`${testId}-backdrop`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        className={`flex max-h-[92dvh] w-full flex-col rounded-xl border border-line bg-panel outline-none ${full ? 'max-w-6xl lg:h-[92dvh]' : wide ? 'max-w-2xl' : 'max-w-lg'}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
            {subtitle && <p className="m-0 mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          <button className="icon-btn" aria-label="Close" data-testid={`${testId}-close`} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const closeUpload = () => setState({ uploadOpen: false });

export function UploadDialog() {
  const open = useStore((s) => s.uploadOpen);
  const uploads = useStore((s) => s.uploads);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  if (!open) return null;
  const finished = uploads.every((u) => u.status === 'done' || u.status === 'error');
  const added = uploads.filter((u) => u.status === 'done').length;
  const toCheck = uploads.filter((u) => u.attention).length;
  const failed = uploads.filter((u) => u.status === 'error').length;
  return (
    <Modal title="Ingest & Archive Lesson PDF" subtitle="Reads scanned and digital PDFs, then indexes the lesson and its verses." onClose={closeUpload} testId="upload-dialog">
      <div className="scroll-stable min-h-0 p-4">
        <div
          data-testid="drop-zone"
          className={`tap flex flex-col items-center rounded-lg border-2 border-dashed p-6 text-center ${dragging ? 'border-accent2 bg-raised' : 'border-line'}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!dragging) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            enqueueFiles(e.dataTransfer.files);
          }}
        >
          <UploadCloud size={30} className="text-accent2" />
          <p className="m-0 mt-2 font-semibold">Drop lesson PDFs here or browse your device</p>
          <p className="m-0 mt-1 mb-3 text-xs text-muted">Midweek, Weekend and Pastoral Visit lessons, in Tagalog or English, up to 64 MB each.</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,application/pdf"
            className="hidden"
            data-testid="upload-input"
            aria-label="PDF files to upload"
            onChange={(e) => {
              if (e.target.files) enqueueFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={(el) => {
              folderRef.current = el;
              el?.setAttribute('webkitdirectory', '');
            }}
            type="file"
            multiple
            className="hidden"
            data-testid="folder-input"
            aria-label="Folder of PDF files to upload"
            onChange={(e) => {
              if (e.target.files) enqueueFolder(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="flex flex-wrap justify-center gap-1.5">
            <button className="btn btn-primary" data-testid="upload-browse" onClick={() => inputRef.current?.click()}>
              <FileUp size={14} /> Select PDF files
            </button>
            <button className="btn" data-testid="upload-folder" onClick={() => folderRef.current?.click()}>
              <FolderUp size={14} /> Select a folder
            </button>
          </div>
        </div>
        {uploads.length > 1 && finished && (
          <p className="m-0 mt-3 rounded-lg border border-line p-2.5 text-[13px]" data-testid="upload-summary">
            {added} added{toCheck ? `, ${toCheck} to check` : ''}{failed ? `, ${failed} could not be added` : ''}.
          </p>
        )}
        {uploads.length > 0 && (
          <ul className="m-0 mt-3 list-none space-y-2 p-0" data-testid="upload-list">
            {uploads.map((u) => (
              <li key={u.id} className="rounded-lg border border-line p-2.5" data-testid="upload-item" data-status={u.status}>
                <div className="flex items-center gap-2">
                  {u.status === 'done' && <CheckCircle2 size={15} className="flex-none text-ok" />}
                  {u.status === 'error' && <CircleAlert size={15} className="flex-none text-danger" />}
                  {(u.status === 'working' || u.status === 'queued') && <Loader2 size={15} className="flex-none animate-spin text-accent2" />}
                  <span className="min-w-0 flex-1 truncate font-medium">{u.name}</span>
                </div>
                <p className="m-0 mt-1 text-xs text-muted" data-testid="upload-message">{u.message}</p>
                {u.attention && <p className="m-0 mt-0.5 text-xs text-warn" data-testid="upload-attention">{u.attention}</p>}
                {u.status === 'done' && u.lessonId && <UploadCheck lessonId={u.lessonId} />}
                {u.status === 'working' && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded bg-raised" role="progressbar" aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Processing ${u.name}`}>
                    <div className="h-full origin-left bg-accent2" style={{ transform: `scaleX(${u.progress})`, transition: 'transform 200ms linear' }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
        <p className="m-0 text-xs text-muted">You can keep working while files process.</p>
        <button className="btn" data-testid="upload-done" onClick={closeUpload}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/** Every upload is checked by hand: the parser can misread a title, an objective or a verse. */
function UploadCheck({ lessonId }: { lessonId: string }) {
  const needsCheck = useStore((s) => s.lessons.find((l) => l.id === lessonId)?.needs_check);
  if (needsCheck === undefined) return null;
  return needsCheck ? (
    <button className="btn mt-1.5 !min-h-8 max-lg:!min-h-11" data-testid="upload-check" onClick={() => setState({ uploadOpen: false, editingLessonId: lessonId })}>
      <ClipboardCheck size={13} /> Check what was read
    </button>
  ) : (
    <p className="m-0 mt-0.5 flex items-center gap-1 text-xs text-ok" data-testid="upload-checked"><CheckCircle2 size={12} /> Checked</p>
  );
}

const closeConfirm = () => setState({ confirm: null });

export function ConfirmDialog() {
  const c = useStore((s) => s.confirm);
  const [typed, setTyped] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTyped('');
    setPassphrase('');
    setBusy(false);
  }, [c]);
  if (!c) return null;
  const blocked = busy || (c.requireText ? typed !== c.requireText : false) || (c.askPassphrase ? !passphrase : false);
  return (
    <Modal title={c.title} onClose={closeConfirm} testId="confirm-dialog">
      <div className="p-4">
        <p className="m-0" data-testid="confirm-body">{c.body}</p>
        {c.requireText && (
          <label className="mt-3 block text-xs text-muted">
            Type {c.requireText} to continue
            <input className="field mt-1" data-testid="confirm-text" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        {c.askPassphrase && (
          <label className="mt-3 block text-xs text-muted">
            Backup passphrase
            <input className="field mt-1" type="password" data-testid="confirm-passphrase" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </label>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
        <button className="btn" data-testid="confirm-cancel" onClick={closeConfirm}>
          Cancel
        </button>
        <button
          className="btn btn-danger"
          data-testid="confirm-accept"
          disabled={blocked}
          onClick={async () => {
            setBusy(true);
            try {
              await c.onConfirm(passphrase);
              closeConfirm();
            } catch (e) {
              setBusy(false);
              toast(errorText(e), 'error');
            }
          }}
        >
          {busy ? 'Working' : c.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

const MIN_PASSPHRASE = 12;
const closeBackup = () => setState({ backupOpen: false });

/** The only copy of the data that can leave this PC, so it is always encrypted. */
export function BackupDialog() {
  const open = useStore((s) => s.backupOpen);
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPassphrase('');
    setAgain('');
    setBusy(false);
  }, [open]);
  if (!open) return null;
  const tooShort = passphrase.length < MIN_PASSPHRASE;
  const mismatch = again !== passphrase;
  return (
    <Modal title="Download an encrypted backup" onClose={closeBackup} testId="backup-dialog">
      <form
        className="contents"
        onSubmit={async (e) => {
          e.preventDefault();
          if (tooShort || mismatch) return;
          setBusy(true);
          try {
            const { blob, name } = await api.backup(passphrase);
            saveFile(blob, name);
            setState({ lastBackupAt: new Date().toISOString() });
            closeBackup();
            toast('Encrypted backup downloaded');
          } catch (err) {
            setBusy(false);
            toast(errorText(err), 'error');
          }
        }}
      >
        <div className="space-y-3 p-4">
          <p className="m-0 text-[13px]" data-testid="backup-warning">
            Choose a passphrase to lock this backup. <strong>If you forget it, the backup cannot be opened by anyone.</strong> Keep it somewhere safe, away from the backup file. This backup is what lets you recover your lessons if this PC fails.
          </p>
          <label className="block text-xs text-muted">
            Passphrase (at least {MIN_PASSPHRASE} characters)
            <input className="field mt-1" type="password" autoComplete="new-password" data-testid="backup-passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </label>
          <label className="block text-xs text-muted">
            Type it again
            <input className="field mt-1" type="password" autoComplete="new-password" data-testid="backup-passphrase-again" value={again} onChange={(e) => setAgain(e.target.value)} />
          </label>
          <p className="m-0 min-h-5 text-xs text-muted" data-testid="backup-hint">
            {passphrase && tooShort ? `${MIN_PASSPHRASE - passphrase.length} more characters needed.` : again && mismatch ? 'The two passphrases do not match.' : ''}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" className="btn" data-testid="backup-cancel" onClick={closeBackup}>Cancel</button>
          <button className="btn btn-primary" data-testid="backup-save" disabled={busy || tooShort || mismatch}>{busy ? 'Encrypting' : 'Download backup'}</button>
        </div>
      </form>
    </Modal>
  );
}

const REMIND_AFTER_DAYS = 14;
const SNOOZE_DAYS = 3;
const DAY_MS = 86_400_000;

function snoozedUntil() {
  try {
    return Number(localStorage.getItem('lv.backupSnooze')) || 0;
  } catch {
    return 0;
  }
}

/** A backup is the only way to recover the vault if this PC fails, so it asks to be kept current. */
export function BackupReminder() {
  const lessons = useStore((s) => s.lessons.length);
  const last = useStore((s) => s.lastBackupAt);
  const [snooze, setSnooze] = useState(snoozedUntil);
  const age = last ? Math.floor((Date.now() - new Date(last).getTime()) / DAY_MS) : null;
  if (lessons === 0 || (age !== null && age < REMIND_AFTER_DAYS) || Date.now() < snooze) return null;
  return (
    <div className="no-print flex flex-none flex-wrap items-center gap-2 border-b border-line bg-raised px-3 py-1.5 text-[13px]" role="status" data-testid="backup-reminder">
      <BellRing size={14} className="flex-none text-warn" />
      <span className="min-w-0 flex-1" data-testid="backup-reminder-text">
        {age === null ? 'You have not made a backup yet.' : `Your last backup was ${age} days ago.`} If this PC fails, a backup is the only way to get your lessons back.
      </span>
      <button className="btn !min-h-7 max-lg:!min-h-11" data-testid="backup-reminder-now" onClick={() => setState({ backupOpen: true })}>Back up now</button>
      <button
        className="btn !min-h-7 max-lg:!min-h-11"
        data-testid="backup-reminder-later"
        onClick={() => {
          const until = Date.now() + SNOOZE_DAYS * DAY_MS;
          try {
            localStorage.setItem('lv.backupSnooze', String(until));
          } catch {
            /* private mode: it still hides for this session */
          }
          setSnooze(until);
        }}
      >
        Remind me later
      </button>
    </div>
  );
}

const closeContext = () => setState({ editingContextKey: null });

/** The user's wording replaces the AI's, and later AI runs leave it alone. */
export function ContextDialog() {
  const key = useStore((s) => s.editingContextKey);
  return key ? <ContextForm key={key} verseKey={key} /> : null;
}

const CONTEXT_PARTS = ['speaker', 'chapter', 'book', 'history', 'verseNote'] as const;
type ContextFields = Record<(typeof CONTEXT_PARTS)[number], string>;

// Keyed by verse, so its fields start filled in rather than being filled just after opening.
function ContextForm({ verseKey: key }: { verseKey: string }) {
  const contexts = useStore((s) => s.contexts);
  const scripture = useStore((s) => s.scripture);
  const tagalog = useStore((s) => s.tagalog);
  const startLanguage = useStore((s) => s.contextLanguage);
  const reference = useStore((s) => s.verses.find((v) => v.canonical_key === key)?.ref_en ?? '');
  const current = backgroundOf({ contexts, scripture, tagalog }, key, startLanguage);
  const english = backgroundOf({ contexts, scripture, tagalog }, key, 'en');
  const items = tagalogItems(key);
  const names = scopeNames(reference);
  const [language, setLanguage] = useState(startLanguage);
  const [en, setEn] = useState<ContextFields>({ speaker: english.speaker, chapter: english.chapter, book: english.book, history: english.history, verseNote: english.verseNote });
  const [tl, setTl] = useState<ContextFields>(() => {
    const text = (part: (typeof CONTEXT_PARTS)[number]) => tagalog[items[part]]?.text ?? '';
    return { speaker: text('speaker'), chapter: text('chapter'), book: text('book'), history: text('history'), verseNote: text('verseNote') };
  });
  // Saving marks wording as reviewed, so only the language the user actually looked at counts.
  const [seen, setSeen] = useState({ en: startLanguage === 'en', tl: startLanguage === 'tl' });
  const [busy, setBusy] = useState(false);
  const fields = language === 'tl' ? tl : en;
  const set = (part: keyof ContextFields, value: string) => (language === 'tl' ? setTl : setEn)((f) => ({ ...f, [part]: value }));
  const placeholder = (part: keyof ContextFields) => (language === 'tl' ? en[part] : undefined);
  const nothing = CONTEXT_PARTS.every((p) => !(seen.en ? en[p] : '').trim() && !(seen.tl ? tl[p] : '').trim());
  return (
    <Modal title="Speaker and context" subtitle={reference} onClose={closeContext} testId="context-dialog" wide>
      <form
        className="contents"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            if (seen.en) {
              const verse = await api.saveVerseContext(key, en.speaker, en.verseNote);
              await api.saveScriptureContext(items.chapter, en.chapter);
              await api.saveScriptureContext(items.book, en.book);
              const saved = await api.saveScriptureContext(items.history, en.history);
              setState({ contexts: verse, scripture: saved });
            }
            if (seen.tl) {
              for (const part of CONTEXT_PARTS) {
                if (tl[part].trim() || tagalog[items[part]]) await api.saveContextTagalog(items[part], tl[part]);
              }
            }
            setState({ tagalog: await api.contextTagalog() });
            closeContext();
            toast(nothing ? 'Context removed' : 'Saved as reviewed');
          } catch (err) {
            setBusy(false);
            toast(errorText(err), 'error');
          }
        }}
      >
        <div className="scroll-stable min-h-0 space-y-3 p-4">
          {!current.empty && !current.reviewed && <p className="m-0 text-xs text-warn" data-testid="context-ai-note">This was written by the AI and can be wrong. Check it, correct it if needed, then save.</p>}
          <ContextLanguageSwitch
            language={language}
            testId="context-dialog-language"
            onChange={(l) => {
              setLanguage(l);
              setSeen((s) => ({ ...s, [l]: true }));
            }}
          />
          <label className="block text-xs text-muted">
            Who is speaking in this verse
            <input className="field mt-1" maxLength={200} data-testid="context-speaker" placeholder={placeholder('speaker')} value={fields.speaker} onChange={(e) => set('speaker', e.target.value)} />
          </label>
          <label className="block text-xs text-muted">
            Chapter context ({names.chapter}). Used for every verse in this chapter.
            <textarea className="field mt-1 min-h-24" maxLength={4000} data-testid="context-chapter" placeholder={placeholder('chapter')} value={fields.chapter} onChange={(e) => set('chapter', e.target.value)} />
          </label>
          <label className="block text-xs text-muted">
            Book context ({names.book}). Used for every verse in this book.
            <textarea className="field mt-1 min-h-24" maxLength={4000} data-testid="context-book" placeholder={placeholder('book')} value={fields.book} onChange={(e) => set('book', e.target.value)} />
          </label>
          <label className="block text-xs text-muted">
            Historical and political context ({names.book}). Used for every verse in this book.
            <textarea className="field mt-1 min-h-24" maxLength={4000} data-testid="context-history" placeholder={placeholder('history')} value={fields.history} onChange={(e) => set('history', e.target.value)} />
          </label>
          <label className="block text-xs text-muted">
            Your note on this verse (optional)
            <textarea className="field mt-1 min-h-16" maxLength={2000} data-testid="context-note" placeholder={placeholder('verseNote')} value={fields.verseNote} onChange={(e) => set('verseNote', e.target.value)} />
          </label>
          <p className="m-0 text-xs text-muted">This never changes the verse itself. Clear a field to remove it. A cleared context can be written again by the AI. Tagalog you save here is kept even if the English changes later.</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" className="btn" data-testid="context-cancel" onClick={closeContext}>Cancel</button>
          <button className="btn btn-primary" data-testid="context-save" disabled={busy}>{busy ? 'Saving' : 'Save as reviewed'}</button>
        </div>
      </form>
    </Modal>
  );
}

const closeEdit = () => setState({ editingLessonId: null });
const replaceVerse = (v: Verse) => setState({ verses: getState().verses.map((x) => (x.id === v.id ? v : x)) });

/** A verse read from this lesson, which can be corrected, or removed if it is not a verse at all. */
function LessonVerse({ verse, lessonId, page, part, question }: { verse: Verse; lessonId: string; page: number; part: string | null; question: string }) {
  const [correcting, setCorrecting] = useState(false);
  const verified = verse.status === 'verified';
  return (
    <li className="rounded-md border border-line p-2" data-testid="check-verse" data-verse-id={verse.id}>
      <div className="flex flex-wrap items-center gap-x-1.5 text-xs">
        <span className="font-semibold text-fg" data-testid="check-verse-ref">{verse.ref_printed}</span>
        <span className="text-muted">{verse.language === 'tl' ? 'Tagalog' : 'English'}{verse.version ? ` · ${verse.version}` : ''} · page {page}</span>
        <span className={verified ? 'text-ok' : 'text-warn'}>{verified ? 'Verified' : 'Unverified'}</span>
      </div>
      {part && (
        <p className="m-0 mt-0.5 text-xs text-pv" data-testid="check-verse-part" title="The part of the lesson it is printed in. A lesson teaches objective 1 in the beginning, objective 2 in I., and so on.">
          {part}{question ? <span className="text-muted"> · {question}</span> : null}
        </p>
      )}
      <p className="m-0 mt-1 line-clamp-3 text-[13px] leading-relaxed" data-testid="check-verse-text">{verse.text || 'Reference only. No text was printed.'}</p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {!verified && (
          <button type="button" className="btn !min-h-7 max-lg:!min-h-11" data-testid="check-verse-correct" onClick={() => setCorrecting(true)}>
            <PencilLine size={12} /> Correct
          </button>
        )}
        <button
          type="button"
          className="btn !min-h-7 max-lg:!min-h-11"
          data-testid="check-verse-remove"
          onClick={() =>
            askConfirm({
              title: `Remove ${verse.ref_printed} from this lesson?`,
              body: 'Use this when what was read is not a verse of this lesson. It stops being listed here. If no other lesson or lecture uses it and it is not verified, it is deleted.',
              confirmLabel: 'Remove from lesson',
              onConfirm: async () => {
                await api.removeLessonVerse(lessonId, verse.id);
                await refreshAll();
                toast(`${verse.ref_printed} removed from this lesson`);
              },
            })
          }
        >
          <Trash2 size={12} /> Not a verse of this lesson
        </button>
      </div>
      {correcting && (
        <VerseCorrectionDialog
          text={verse.text}
          raw={verse.ocr_raw}
          reference={verse.ref_printed}
          onClose={() => setCorrecting(false)}
          onSave={async (patch) => {
            replaceVerse(await api.correctVerse(verse.id, patch));
            setCorrecting(false);
            toast('Correction saved');
          }}
        />
      )}
    </li>
  );
}

/**
 * Edits a lesson's details. A lesson that was just uploaded opens here to be checked:
 * what the parser read is shown beside the PDF, so the two can be compared and confirmed.
 */
export function EditLessonDialog() {
  const id = useStore((s) => s.editingLessonId);
  const lesson = useStore((s) => s.lessons.find((l) => l.id === s.editingLessonId) ?? null);
  const folders = useStore((s) => s.folders);
  const verses = useStore((s) => s.verses);
  const [form, setForm] = useState({ title: '', category: 'weekend' as Category, language: 'en' as Language, lesson_date: '', location: '', author: '', folder_id: '', issue: '', objectives: '' });
  const [saving, setSaving] = useState(false);
  // Fixed when the dialog opens, so confirming does not change the dialog under the user.
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (lesson) {
      setForm({
        title: lesson.title,
        category: lesson.category,
        language: lesson.language,
        lesson_date: lesson.lesson_date ?? '',
        location: lesson.location,
        author: lesson.author,
        folder_id: lesson.folder_id ?? '',
        issue: lesson.issue,
        objectives: lesson.objectives.join('\n'),
      });
      setSaving(false);
      setChecking(lesson.needs_check);
      // The PDF beside the form opens at this lesson's first page.
      if (getState().selectedId !== lesson.id) selectLesson(lesson.id);
    }
    // Only when a different lesson opens; background refreshes must not wipe typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const found = useMemo(() => {
    if (!lesson) return [];
    const order = (v: Verse) => lesson.verse_keys.indexOf(v.canonical_key);
    return verses
      .flatMap((v) => {
        const source = v.sources.find((x) => x.lesson_id === lesson.id);
        return source ? [{ verse: v, page: source.page, part: partName(source.section, lesson.language, lesson.objectives.length), question: source.question }] : [];
      })
      .sort((a, b) => a.page - b.page || order(a.verse) - order(b.verse) || a.verse.language.localeCompare(b.verse.language));
  }, [verses, lesson]);
  if (!id || !lesson) return null;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async (checked: boolean) => {
    setSaving(true);
    try {
      await api.patchLesson(id, { ...form, objectives: form.objectives.split('\n'), ...(checked ? { checked: true } : {}) });
      await refreshAll();
      closeEdit();
      toast(checked ? 'Lesson checked and confirmed' : 'Lesson updated');
    } catch (err) {
      setSaving(false);
      toast(errorText(err), 'error');
    }
  };
  return (
    <Modal
      title={checking ? 'Check what was read from this PDF' : 'Edit lesson details'}
      subtitle={checking ? `${lesson.file_name}. Compare each part with the PDF, correct anything that is wrong, then confirm.` : lesson.file_name}
      onClose={closeEdit}
      testId="edit-dialog"
      full
    >
      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-testid="edit-body" data-mode={checking ? 'check' : 'edit'}>
          <div className="hidden min-h-0 border-r border-line lg:block" data-testid="check-pdf">
            <PdfViewer lesson={lesson} embedded />
          </div>
          <div className="scroll-stable min-h-0 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-xs text-muted sm:col-span-2">
                Title
                <input className="field mt-1" required data-testid="edit-title" value={form.title} onChange={set('title')} />
              </label>
              <label className="text-xs text-muted sm:col-span-2">
                Issue
                <textarea className="field mt-1 min-h-20" data-testid="edit-issue" value={form.issue} onChange={set('issue')} />
              </label>
              <label className="text-xs text-muted sm:col-span-2">
                Objectives (one per line)
                <textarea className="field mt-1 min-h-24" data-testid="edit-objectives" value={form.objectives} onChange={set('objectives')} />
              </label>
              <label className="text-xs text-muted">
                Category
                <select className="field mt-1" data-testid="edit-category" value={form.category} onChange={set('category')}>
                  <option value="midweek">Midweek</option>
                  <option value="weekend">Weekend</option>
                  <option value="pastoral">Pastoral Visit</option>
                </select>
              </label>
              <label className="text-xs text-muted">
                Language
                <select className="field mt-1" data-testid="edit-language" value={form.language} onChange={set('language')}>
                  <option value="tl">Tagalog</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label className="text-xs text-muted">
                Date
                <input className="field mt-1" type="date" data-testid="edit-date" value={form.lesson_date} onChange={set('lesson_date')} />
              </label>
              <label className="text-xs text-muted">
                Folder
                <select className="field mt-1" data-testid="edit-folder" value={form.folder_id} onChange={set('folder_id')}>
                  <option value="">No folder</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted">
                Location
                <input className="field mt-1" data-testid="edit-location" value={form.location} onChange={set('location')} />
              </label>
              <label className="text-xs text-muted">
                Author
                <input className="field mt-1" data-testid="edit-author" value={form.author} onChange={set('author')} />
              </label>
            </div>
            <section className="mt-4" aria-label="Verses found" data-testid="check-verses">
              <h3 className="m-0 text-[13px] font-semibold" data-testid="check-verses-title">Verses found ({found.length})</h3>
              <p className="m-0 mt-0.5 mb-2 text-xs text-muted">
                Check that each verse sits under the right objective and part, correct a verse that was misread, or remove anything that is not a verse of this lesson. Each verse's wording is checked word for word later, in Review Verses.
              </p>
              {found.length === 0 ? (
                <p className="m-0 text-[13px] text-muted" data-testid="check-verses-empty">No verses were found in this PDF.</p>
              ) : (
                <ul className="m-0 list-none space-y-2 p-0">
                  {found.map(({ verse, page, part, question }) => <LessonVerse key={verse.id} verse={verse} lessonId={lesson.id} page={page} part={part} question={question} />)}
                </ul>
              )}
            </section>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
          {checking && <p className="m-0 mr-auto text-xs text-muted">Confirming records that you checked it. You can still edit it later.</p>}
          <button type="button" className="btn" data-testid="edit-cancel" onClick={closeEdit}>
            Cancel
          </button>
          <button className={`btn ${checking ? '' : 'btn-primary'}`} data-testid="edit-save" disabled={saving}>
            {saving ? 'Saving' : checking ? 'Save, check later' : 'Save changes'}
          </button>
          {checking && (
            <button type="button" className="btn btn-primary" data-testid="edit-confirm" disabled={saving || !form.title.trim()} onClick={() => void save(true)}>
              <ClipboardCheck size={14} /> Confirm it is correct
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export function VerseCorrectionDialog({ text, raw, reference, onSave, onClose }: { text: string; raw: string; reference: string; onSave: (patch: { text: string; reference: string }) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(text);
  const [refValue, setRefValue] = useState(reference);
  const [saving, setSaving] = useState(false);
  return (
    <Modal title={`Correct scan errors: ${reference}`} subtitle="Compare with the printed page. Fix recognition errors only, never the wording." onClose={onClose} testId="correct-dialog" wide>
      <div className="scroll-stable min-h-0 space-y-3 p-4">
        <label className="block text-xs text-muted">
          Reference
          <input className="field mt-1" data-testid="correct-reference" value={refValue} onChange={(e) => setRefValue(e.target.value)} />
        </label>
        <label className="block text-xs text-muted">
          Verse text
          <textarea className="field mt-1 min-h-40" data-testid="correct-text" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div>
          <p className="m-0 mb-1 text-xs text-muted">Original extraction (kept permanently)</p>
          <p className="m-0 max-h-32 overflow-auto rounded-lg border border-line p-2 text-[13px] whitespace-pre-wrap" data-testid="correct-raw">{raw}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
        <button className="btn" data-testid="correct-cancel" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          data-testid="correct-save"
          disabled={saving || !value.trim() || !refValue.trim()}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave({ text: value, reference: refValue });
              return;
            } catch (e) {
              setSaving(false);
              toast(errorText(e), 'error');
            }
          }}
        >
          {saving ? 'Saving' : 'Save correction'}
        </button>
      </div>
    </Modal>
  );
}

export function ToastRegion() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div aria-live="polite" className="no-print pointer-events-none fixed right-3 bottom-[76px] z-[60] flex w-[min(92vw,380px)] flex-col gap-2 lg:bottom-4" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} role="status" data-testid="toast" data-kind={t.kind} className={`fade-in pointer-events-auto rounded-lg border bg-raised px-3 py-2 text-[13px] ${t.kind === 'error' ? 'border-danger' : 'border-line'}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
