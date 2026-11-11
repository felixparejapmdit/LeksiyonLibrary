import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, FolderInput, Loader2, X } from 'lucide-react';
import { api, type Category, type Lesson } from '../api';
import { documentLabel } from '../documents';
import { errorText, openLesson, openScope, refreshAll, toast } from '../store';

/** Refile the existing lesson document; its identity and saved wording are kept. */
export function MoveLessonDialog({ lesson, onClose }: { lesson: Lesson; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fromPastoral = lesson.category === 'pastoral';
  const [category, setCategory] = useState<Category>(fromPastoral ? 'weekend' : 'pastoral');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const destination = fromPastoral ? 'Lesson Library' : 'Pastoral Visits';

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus?.();
  }, []);

  const move = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.moveLesson(lesson.id, category);
      await refreshAll();
      onClose();
      openScope(fromPastoral ? 'lessons' : 'pastoral');
      openLesson(lesson.id);
      toast(`Moved to ${destination}. Check the ${documentLabel(lesson)} in its new library.`);
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="move-lesson-title"
      className="fixed inset-0 m-auto max-h-[92dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-auto rounded-xl border border-line bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/65"
      data-testid="move-lesson-dialog"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <form onSubmit={move}>
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id="move-lesson-title" className="m-0 flex items-center gap-2 text-base font-semibold"><FolderInput size={18} /> Move lesson</h2>
            <p className="m-0 mt-1 text-xs text-muted break-words">{lesson.title}</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close move dialog" data-testid="move-lesson-close" disabled={busy} onClick={onClose}><X size={18} /></button>
        </div>
        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg p-3 text-[13px]">
            <span>{fromPastoral ? 'Pastoral Visits' : 'Lesson Library'}</span><ArrowRight size={15} className="text-muted" /><strong>{destination}</strong>
          </div>
          {fromPastoral && (
            <label className="block text-xs text-muted">
              Lesson category
              <select className="field mt-1" value={category} onChange={(event) => setCategory(event.target.value as Category)} data-testid="move-lesson-category" disabled={busy}>
                <option value="weekend">Weekend</option>
                <option value="midweek">Midweek</option>
              </select>
            </label>
          )}
          <p className="m-0 text-[13px] leading-relaxed text-muted">The {documentLabel(lesson)}, date, language, and saved wording stay with this lesson. Its year folder and verse sources will update to the destination library.</p>
          <p className="m-0 text-xs leading-relaxed text-muted">The lesson will be marked for checking in its new library. Verified verses stay locked, and saved lectures keep their verse links.</p>
          {error && <p role="alert" className="m-0 text-[13px] text-danger" data-testid="move-lesson-error">{error}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 sm:px-5">
          <button type="button" className="btn" disabled={busy} onClick={onClose} data-testid="move-lesson-cancel">Cancel</button>
          <button className="btn btn-primary" disabled={busy} data-testid="move-lesson-confirm">{busy ? <Loader2 size={15} className="animate-spin" /> : <FolderInput size={15} />} Move to {destination}</button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
