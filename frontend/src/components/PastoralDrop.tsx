import { useRef, useState } from 'react';
import { CheckCircle2, FileUp, FolderUp, Loader2, UploadCloud, X } from 'lucide-react';
import { enqueueFolder } from '../ingest';
import type { UploadTarget } from '../api';
import { LESSON_FILE_ACCEPT } from '../documents';
import { setState, useStore } from '../store';

/** Pastoral visit documents dropped or chosen here; unsupported files are skipped. */
export function addPastoralVisits(files: Iterable<File>) {
  enqueueFolder(files, 'pastoral');
}

/**
 * The Pastoral Visits page's own upload: drop several documents at once, or choose them. Each is read
 * in turn, with its progress shown here, and every verse goes to the Verse Library.
 */
export function PastoralDrop({ dragging }: { dragging: boolean }) {
  return <PdfDrop dragging={dragging} target="pastoral" />;
}

/** Both libraries accept PDF and DOCX batches or a folder and show progress in place. */
export function PdfDrop({ dragging, target }: { dragging: boolean; target: UploadTarget }) {
  const pastoral = target === 'pastoral';
  const prefix = pastoral ? 'pv' : 'lesson';
  const addFiles = (files: Iterable<File>) => enqueueFolder(files, target);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const uploads = useStore((s) => s.uploads);
  // Only this page's uploads since it was last cleared are summed up here.
  const [since, setSince] = useState(() => (uploads.length ? uploads[uploads.length - 1].id : 0));
  const batch = uploads.filter((u) => u.target === target && u.id > since);
  const running = batch.filter((u) => u.status === 'queued' || u.status === 'working');
  const current = batch.find((u) => u.status === 'working');
  const done = batch.filter((u) => u.status === 'done');
  const failed = batch.filter((u) => u.status === 'error').length;
  const toCheck = done.filter((u) => u.attention).length;
  const share = batch.length ? batch.reduce((n, u) => n + (u.status === 'queued' ? 0 : u.progress), 0) / batch.length : 0;

  return (
    <div
      className={`mt-2 rounded-lg border-2 border-dashed px-3 py-2.5 transition-colors ${dragging ? 'border-accent2 bg-raised' : 'border-line'}`}
      data-testid={`${prefix}-drop`}
      data-dragging={dragging || undefined}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <UploadCloud size={20} className={`flex-none ${pastoral ? 'text-pv' : 'text-accent2'}`} />
        <p className="m-0 min-w-0 flex-1 basis-48 text-[13px]">
          <span className="font-semibold">Drop {pastoral ? 'pastoral visit' : 'lesson'} PDF or DOCX files here</span>
          <span className="text-muted"> · several at once. {pastoral ? 'Every verse in each one goes to the Verse Library.' : 'Each document is added to the Lesson Library.'}</span>
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={LESSON_FILE_ACCEPT}
          className="hidden"
          data-testid={`${prefix}-drop-input`}
          aria-label={`${pastoral ? 'Pastoral visit' : 'Lesson'} PDF or DOCX files to upload`}
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
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
          data-testid={`${prefix}-drop-folder-input`}
          aria-label={`Folder of ${pastoral ? 'pastoral visit' : 'lesson'} PDF or DOCX files to upload`}
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="flex max-w-full flex-none flex-wrap items-center gap-2">
          <button className="btn btn-primary !min-h-8 max-lg:!min-h-11" data-testid={`${prefix}-drop-browse`} onClick={() => inputRef.current?.click()}>
            <FileUp size={14} /> Select files
          </button>
          <button className="btn !min-h-8 max-lg:!min-h-11" data-testid={`${prefix}-drop-folder`} onClick={() => folderRef.current?.click()}>
            <FolderUp size={14} /> Folder
          </button>
        </div>
      </div>
      {batch.length > 0 && (
        <div className="mt-2 border-t border-line pt-2 text-xs" data-testid={`${prefix}-drop-status`} data-running={running.length > 0 || undefined}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {running.length > 0 ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted" data-testid={`${prefix}-drop-progress`}>
                <Loader2 size={13} className="flex-none animate-spin text-accent2" />
                <span className="truncate">
                  Reading {done.length + failed + 1} of {batch.length}
                  {current ? `: ${current.name} · ${current.message}` : ''}
                </span>
              </span>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1.5" data-testid={`${prefix}-drop-summary`}>
                <CheckCircle2 size={13} className="flex-none text-ok" />
                {done.length} {pastoral ? (done.length === 1 ? 'visit' : 'visits') : (done.length === 1 ? 'lesson' : 'lessons')} added, with {done.reduce((n, u) => n + (u.verseCount ?? 0), 0)} verses
                {toCheck ? `, ${toCheck} to check` : ''}
                {failed ? `, ${failed} could not be added` : ''}.
              </span>
            )}
            <button className="btn !min-h-7 max-lg:!min-h-11" data-testid={`${prefix}-drop-details`} onClick={() => setState({ uploadOpen: true, uploadTarget: target })}>
              {running.length > 0 ? 'Details' : 'Check what was read'}
            </button>
            {running.length === 0 && (
              <button className="icon-btn !h-7 !w-7 max-lg:!h-11 max-lg:!w-11" aria-label="Clear this summary" data-testid={`${prefix}-drop-clear`} onClick={() => setSince(batch[batch.length - 1].id)}>
                <X size={13} />
              </button>
            )}
          </div>
          {running.length > 0 && (
            <div className="mt-1.5 h-1 overflow-hidden rounded bg-raised" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Reading ${pastoral ? 'pastoral visits' : 'lessons'}`}>
              <div className="h-full origin-left bg-accent2" style={{ transform: `scaleX(${share})`, transition: 'transform 200ms linear' }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
