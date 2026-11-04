import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, CircleAlert, FileUp, Loader2, UploadCloud, X } from 'lucide-react';
import { api, type Category, type Language } from '../api';
import { enqueueFiles } from '../ingest';
import { errorText, refreshAll, setState, toast, useStore } from '../store';

function Modal({ title, subtitle, onClose, children, testId, wide }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; testId: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
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
        className={`flex max-h-[92dvh] w-full flex-col rounded-xl border border-line bg-panel outline-none ${wide ? 'max-w-2xl' : 'max-w-lg'}`}
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
  const [dragging, setDragging] = useState(false);
  if (!open) return null;
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
          <button className="btn btn-primary" data-testid="upload-browse" onClick={() => inputRef.current?.click()}>
            <FileUp size={14} /> Select PDF files
          </button>
        </div>
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
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = name;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
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

const closeEdit = () => setState({ editingLessonId: null });

export function EditLessonDialog() {
  const id = useStore((s) => s.editingLessonId);
  const lesson = useStore((s) => s.lessons.find((l) => l.id === s.editingLessonId) ?? null);
  const folders = useStore((s) => s.folders);
  const [form, setForm] = useState({ title: '', category: 'weekend' as Category, language: 'en' as Language, lesson_date: '', location: '', author: '', folder_id: '', issue: '', objectives: '' });
  const [saving, setSaving] = useState(false);
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
    }
    // Only when a different lesson opens; background refreshes must not wipe typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!id || !lesson) return null;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal title="Edit lesson details" subtitle={lesson.file_name} onClose={closeEdit} testId="edit-dialog">
      <form
        className="contents"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            await api.patchLesson(id, { ...form, objectives: form.objectives.split('\n') });
            await refreshAll();
            closeEdit();
            toast('Lesson updated');
          } catch (err) {
            setSaving(false);
            toast(errorText(err), 'error');
          }
        }}
      >
        <div className="scroll-stable grid min-h-0 grid-cols-1 gap-3 p-4 sm:grid-cols-2">
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
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" className="btn" data-testid="edit-cancel" onClick={closeEdit}>
            Cancel
          </button>
          <button className="btn btn-primary" data-testid="edit-save" disabled={saving}>
            {saving ? 'Saving' : 'Save changes'}
          </button>
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
