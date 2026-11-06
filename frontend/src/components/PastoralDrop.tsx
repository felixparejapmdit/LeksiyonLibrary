import { useRef, useState } from 'react';
import { CheckCircle2, FileUp, FolderUp, Loader2, UploadCloud, X } from 'lucide-react';
import { enqueueFolder } from '../ingest';
import { setState, useStore } from '../store';

/** Pastoral visit PDFs dropped or chosen here; anything else in the selection is skipped. */
export function addPastoralVisits(files: Iterable<File>) {
  enqueueFolder(files, 'pastoral');
}

/**
 * The Pastoral Visits page's own upload: drop several PDFs at once, or choose them. Each is read
 * in turn, with its progress shown here, and every verse goes to the Verse Library.
 */
export function PastoralDrop({ dragging }: { dragging: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const uploads = useStore((s) => s.uploads);
  // Only this page's uploads since it was last cleared are summed up here.
  const [since, setSince] = useState(() => (uploads.length ? uploads[uploads.length - 1].id : 0));
  const batch = uploads.filter((u) => u.target === 'pastoral' && u.id > since);
  const running = batch.filter((u) => u.status === 'queued' || u.status === 'working');
  const current = batch.find((u) => u.status === 'working');
  const done = batch.filter((u) => u.status === 'done');
  const failed = batch.filter((u) => u.status === 'error').length;
  const toCheck = done.filter((u) => u.attention).length;
  const share = batch.length ? batch.reduce((n, u) => n + (u.status === 'queued' ? 0 : u.progress), 0) / batch.length : 0;

  return (
    <div
      className={`mt-2 rounded-lg border-2 border-dashed px-3 py-2.5 transition-colors ${dragging ? 'border-accent2 bg-raised' : 'border-line'}`}
      data-testid="pv-drop"
      data-dragging={dragging || undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <UploadCloud size={20} className="flex-none text-pv" />
        <p className="m-0 min-w-0 flex-1 text-[13px]">
          <span className="font-semibold">Drop pastoral visit PDFs here</span>
          <span className="text-muted"> · several at once. Every verse in each one goes to the Verse Library.</span>
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,application/pdf"
          className="hidden"
          data-testid="pv-drop-input"
          aria-label="Pastoral visit PDFs to upload"
          onChange={(e) => {
            if (e.target.files) addPastoralVisits(e.target.files);
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
          data-testid="pv-drop-folder-input"
          aria-label="Folder of pastoral visit PDFs to upload"
          onChange={(e) => {
            if (e.target.files) addPastoralVisits(e.target.files);
            e.target.value = '';
          }}
        />
        <button className="btn btn-primary !min-h-8 max-lg:!min-h-11" data-testid="pv-drop-browse" onClick={() => inputRef.current?.click()}>
          <FileUp size={14} /> Select PDFs
        </button>
        <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="pv-drop-folder" onClick={() => folderRef.current?.click()}>
          <FolderUp size={14} /> Folder
        </button>
      </div>
      {batch.length > 0 && (
        <div className="mt-2 border-t border-line pt-2 text-xs" data-testid="pv-drop-status" data-running={running.length > 0 || undefined}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {running.length > 0 ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted" data-testid="pv-drop-progress">
                <Loader2 size={13} className="flex-none animate-spin text-accent2" />
                <span className="truncate">
                  Reading {done.length + failed + 1} of {batch.length}
                  {current ? `: ${current.name} · ${current.message}` : ''}
                </span>
              </span>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1.5" data-testid="pv-drop-summary">
                <CheckCircle2 size={13} className="flex-none text-ok" />
                {done.length} {done.length === 1 ? 'visit' : 'visits'} added, with {done.reduce((n, u) => n + (u.verseCount ?? 0), 0)} verses
                {toCheck ? `, ${toCheck} to check` : ''}
                {failed ? `, ${failed} could not be added` : ''}.
              </span>
            )}
            <button className="btn !min-h-7 max-lg:!min-h-11" data-testid="pv-drop-details" onClick={() => setState({ uploadOpen: true, uploadTarget: 'pastoral' })}>
              {running.length > 0 ? 'Details' : 'Check what was read'}
            </button>
            {running.length === 0 && (
              <button className="icon-btn !h-7 !w-7 max-lg:!h-11 max-lg:!w-11" aria-label="Clear this summary" data-testid="pv-drop-clear" onClick={() => setSince(batch[batch.length - 1].id)}>
                <X size={13} />
              </button>
            )}
          </div>
          {running.length > 0 && (
            <div className="mt-1.5 h-1 overflow-hidden rounded bg-raised" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Reading pastoral visits">
              <div className="h-full origin-left bg-accent2" style={{ transform: `scaleX(${share})`, transition: 'transform 200ms linear' }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
