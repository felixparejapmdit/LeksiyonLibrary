import { useRef, useState } from 'react';
import { Check, FileSpreadsheet, Link2, Loader2, Trash2, Upload } from 'lucide-react';
import { api, type ImportReport, type RowToFix } from '../api';
import { askConfirm, errorText, refreshAll, setState, toast, useStore } from '../store';

type Source = { kind: 'file'; file: File } | { kind: 'sheet'; sheet: string };

const run = (source: Source, commit: boolean) => (source.kind === 'file' ? api.importVerses(source.file, commit) : api.importGoogleSheet(source.sheet, commit));

function FixList({ title, fixes, testId }: { title: string; fixes: ImportReport['book_fixes']; testId: string }) {
  if (fixes.length === 0) return null;
  return (
    <details className="text-xs" data-testid={testId}>
      <summary className="cursor-pointer">{title} ({fixes.reduce((n, f) => n + f.count, 0)} rows)</summary>
      <ul className="m-0 mt-1 list-none space-y-0.5 p-0 pl-3">
        {fixes.map((f) => <li key={`${f.from}-${f.to}`}>{f.from} became {f.to} ({f.count})</li>)}
      </ul>
    </details>
  );
}

function IssueList({ title, issues, testId, open }: { title: string; issues: ImportReport['problems']; testId: string; open?: boolean }) {
  if (issues.length === 0) return null;
  return (
    <details className="text-xs" data-testid={testId} open={open}>
      <summary className="cursor-pointer text-warn">{title} ({issues.length})</summary>
      <ul className="m-0 mt-1 max-h-48 list-none space-y-0.5 overflow-auto p-0 pl-3">
        {issues.map((i) => <li key={`${i.row}-${i.message}`}><span className="font-semibold">Row {i.row}:</span> {i.message}</li>)}
      </ul>
    </details>
  );
}

/** A row an import left out. Saving runs it through the same checks as the sheet. */
function RowFix({ row }: { row: RowToFix }) {
  const [draft, setDraft] = useState({ translation: row.translation, book: row.choices.length > 0 ? '' : row.book, chapter: row.chapter, verse: row.verse, content: row.content });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const act = async (work: () => Promise<RowToFix[]>, done: string) => {
    setBusy(true);
    try {
      const rowsToFix = await work();
      await refreshAll();
      setState({ rowsToFix });
      toast(done);
    } catch (e) {
      setBusy(false);
      toast(errorText(e), 'error');
    }
  };
  const small = 'field !min-h-[34px] !py-1 !text-xs max-lg:!min-h-11';
  return (
    <li className="rounded-md border border-line p-2" data-testid="fix-row" data-row={row.row}>
      <p className="m-0 text-xs font-semibold" data-testid="fix-row-title">Row {row.row} of {row.source}</p>
      <p className="m-0 mt-0.5 text-xs text-warn" data-testid="fix-row-message">{row.message}</p>
      <div className="mt-2 flex flex-wrap items-end gap-1.5">
        <label className="w-24 text-xs text-muted">
          Translation
          <input className={`${small} mt-0.5`} data-testid="fix-row-translation" value={draft.translation} onChange={(e) => set({ translation: e.target.value })} />
        </label>
        <label className="min-w-36 flex-1 text-xs text-muted">
          Book
          {row.choices.length > 0 ? (
            <select className={`${small} mt-0.5`} data-testid="fix-row-book" value={draft.book} onChange={(e) => set({ book: e.target.value })}>
              <option value="">Choose the book ({row.book})</option>
              {row.choices.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input className={`${small} mt-0.5`} data-testid="fix-row-book" value={draft.book} onChange={(e) => set({ book: e.target.value })} />
          )}
        </label>
        <label className="w-16 text-xs text-muted">
          Chapter
          <input className={`${small} mt-0.5`} data-testid="fix-row-chapter" value={draft.chapter} onChange={(e) => set({ chapter: e.target.value })} />
        </label>
        <label className="w-16 text-xs text-muted">
          Verse
          <input className={`${small} mt-0.5`} data-testid="fix-row-verse" value={draft.verse} onChange={(e) => set({ verse: e.target.value })} />
        </label>
      </div>
      <label className="mt-1.5 block text-xs text-muted">
        Text
        <textarea className={`${small} mt-0.5 min-h-14`} data-testid="fix-row-content" value={draft.content} onChange={(e) => set({ content: e.target.value })} />
      </label>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button className="btn btn-primary !min-h-8 max-lg:!min-h-11" data-testid="fix-row-save" disabled={busy || !draft.book.trim()} onClick={() => act(() => api.fixRow(row.id, draft), `Row ${row.row} added to your verses`)}>
          <Check size={13} /> Save this verse
        </button>
        <button
          className="btn !min-h-8 max-lg:!min-h-11"
          data-testid="fix-row-dismiss"
          disabled={busy}
          onClick={() =>
            askConfirm({
              title: `Leave out row ${row.row}?`,
              body: 'This row will not be added to your verses. It comes back if you import the sheet again without fixing it there.',
              confirmLabel: 'Leave it out',
              onConfirm: () => act(() => api.dismissRow(row.id), `Row ${row.row} left out`),
            })
          }
        >
          Leave out
        </button>
      </div>
    </li>
  );
}

/** Bulk verses from an Excel file or Google Sheet, always previewed before anything is saved. */
export function VerseImport() {
  const verses = useStore((s) => s.verses);
  const rowsToFix = useStore((s) => s.rowsToFix);
  const hasSavedSheet = useStore((s) => s.hasSavedSheet);
  const inputRef = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ source: Source; report: ImportReport } | null>(null);
  const imported = verses.filter((v) => v.import_source).length;

  const inspect = async (source: Source) => {
    setBusy(true);
    setPreview(null);
    try {
      setPreview({ source, report: await run(source, false) });
      if (source.kind === 'sheet') setState({ hasSavedSheet: true });
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const report = await run(preview.source, true);
      await refreshAll();
      setPreview(null);
      setSheet('');
      const left = report.problems.length;
      toast(left > 0 ? `${report.new_verses} verses imported and encrypted. ${left} ${left === 1 ? 'row' : 'rows'} to fix below.` : `${report.new_verses} verses imported and encrypted`);
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };

  const r = preview?.report;
  return (
    <section className="rounded-lg border border-line bg-panel p-3" data-testid="verse-import">
      <h2 className="m-0 mb-1 text-[14px] font-semibold">Import Bible verses</h2>
      <p className="m-0 mb-2 text-[13px] text-muted">
        Add translations from a sheet with these columns: Translation (or PET), Book, Chapter, Verse and Content. You see what will happen before anything is saved. Imported verses are encrypted with the rest of your vault and stay unverified until you check them.
      </p>

      <h3 className="m-0 mb-1 text-[13px] font-semibold">From an Excel file (most private)</h3>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        data-testid="import-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) inspect({ kind: 'file', file });
        }}
      />
      <button className="btn" data-testid="import-choose" disabled={busy} onClick={() => inputRef.current?.click()}>
        <FileSpreadsheet size={14} /> Choose .xlsx file
      </button>

      <h3 className="m-0 mt-3 mb-1 text-[13px] font-semibold">From Google Sheets</h3>
      <form
        className="flex flex-wrap gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (sheet.trim()) inspect({ kind: 'sheet', sheet: sheet.trim() });
        }}
      >
        <input
          className="field min-w-52 flex-1"
          aria-label="Google Sheets link or gid"
          data-testid="import-sheet"
          placeholder={hasSavedSheet ? 'gid of a tab, or a new Google Sheets link' : 'Paste the Google Sheets link'}
          value={sheet}
          onChange={(e) => setSheet(e.target.value)}
        />
        <button className="btn" data-testid="import-sheet-load" disabled={busy || !sheet.trim()}>
          <Link2 size={14} /> Load sheet
        </button>
      </form>
      <p className="m-0 mt-1 text-xs text-warn" data-testid="import-sheet-warning">
        The sheet must be shared as "Anyone with the link", which means anyone who gets the link can read it, not only you. For sensitive verses, turn that sharing off again after importing, or use an Excel file instead.
      </p>
      {hasSavedSheet && <p className="m-0 mt-1 text-xs text-muted" data-testid="import-sheet-saved">Your spreadsheet is remembered, so the gid alone is enough for its other tabs. The gid is the number after gid= in the sheet's address.</p>}

      {busy && <p className="m-0 mt-2 flex items-center gap-1 text-xs text-muted" data-testid="import-busy"><Loader2 size={12} className="animate-spin" /> Working</p>}

      {r && (
        <div className="mt-3 space-y-1.5 rounded-md border border-line p-2 text-[13px]" data-testid="import-preview">
          <p className="m-0 font-semibold" data-testid="import-summary">{r.new_verses} new {r.new_verses === 1 ? 'verse' : 'verses'} ready to import from {r.file}</p>
          <p className="m-0 text-xs text-muted" data-testid="import-counts">
            {r.rows} rows read. {r.tagalog} Tagalog, {r.english} English, in {r.translations.length} {r.translations.length === 1 ? 'translation' : 'translations'}.
            {r.duplicates_in_file > 0 && ` ${r.duplicates_in_file} repeated rows skipped.`}
            {r.already_in_vault > 0 && ` ${r.already_in_vault} already in your vault.`}
            {r.other_wordings > 0 && ` ${r.other_wordings} are another wording of a verse in the same translation, and all wordings are kept.`}
          </p>
          <IssueList title="Rows left out. After you continue, you can fix them here under Rows to fix" issues={r.problems} testId="import-problems" open />
          <IssueList title="Imported, but marked for you to check" issues={r.flagged} testId="import-flagged" />
          <IssueList title="Verse numbers corrected to match the Verse column" issues={r.number_fixes} testId="import-number-fixes" />
          <FixList title="Book names corrected" fixes={r.book_fixes} testId="import-book-fixes" />
          <FixList title="Translation codes corrected, such as Excel counting up AMP2015 to AMP2016" fixes={r.translation_fixes} testId="import-translation-fixes" />
          <div className="flex flex-wrap gap-1.5 pt-1">
            <button className="btn btn-primary" data-testid="import-confirm" disabled={busy || (r.new_verses === 0 && r.problems.length === 0)} onClick={commit}>
              <Upload size={14} /> {r.new_verses === 0 && r.problems.length > 0 ? `Keep ${r.problems.length} ${r.problems.length === 1 ? 'row' : 'rows'} to fix` : `Import ${r.new_verses} ${r.new_verses === 1 ? 'verse' : 'verses'}`}
            </button>
            <button className="btn" data-testid="import-cancel" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>
      )}

      {rowsToFix.length > 0 && (
        <div className="mt-3 border-t border-line pt-2" data-testid="rows-to-fix">
          <h3 className="m-0 text-[13px] font-semibold" data-testid="rows-to-fix-title">Rows to fix ({rowsToFix.length})</h3>
          <p className="m-0 mt-0.5 mb-2 text-xs text-muted">These rows were not imported. Correct each one here to add it to your verses. They are kept encrypted in your vault until then.</p>
          <ul className="m-0 list-none space-y-2 p-0">
            {rowsToFix.map((row) => <RowFix key={row.id} row={row} />)}
          </ul>
        </div>
      )}

      {imported > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2">
          <span className="text-[13px] text-muted" data-testid="import-count">{imported} imported {imported === 1 ? 'verse' : 'verses'} in your vault.</span>
          <button
            className="btn"
            data-testid="import-remove"
            onClick={() =>
              askConfirm({
                title: 'Remove imported verses?',
                body: 'Imported verses, and any rows waiting to be fixed, are removed from your vault. Any verse you have verified, or added to a saved lecture, is kept.',
                confirmLabel: 'Remove imported verses',
                onConfirm: async () => {
                  const res = await api.removeImported();
                  await refreshAll();
                  toast(res.kept > 0 ? `${res.removed} removed. ${res.kept} kept because you verified them or use them.` : `${res.removed} removed`);
                },
              })
            }
          >
            <Trash2 size={14} /> Remove imported verses
          </button>
        </div>
      )}
    </section>
  );
}
