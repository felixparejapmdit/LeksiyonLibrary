import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, FileSpreadsheet, FileText, ListChecks, Lock, Save, ShieldAlert } from 'lucide-react';
import { api, type Verse } from '../api';
import { PdfViewer } from '../components/PdfViewer';
import { errorText, getState, libraryName, libraryOf, navigate, selectLesson, setState, toast, useStore, type Library } from '../store';

const replaceVerse = (v: Verse) => setState({ verses: getState().verses.map((x) => (x.id === v.id ? v : x)) });

// The library being reviewed, kept while the app is open.
let savedLibrary: Library | null = null;

/** Opens Review Verses on one library's verses. */
export function openReview(library: Library) {
  savedLibrary = library;
  navigate('/review');
}

function LibraryTabs({ library, counts, onChange }: { library: Library; counts: Record<Library, number>; onChange: (l: Library) => void }) {
  return (
    <div className="flex rounded-lg border border-line" role="tablist" aria-label="Library" data-testid="review-libraries">
      {(['verse', 'lesson'] as const).map((l) => (
        <button
          key={l}
          role="tab"
          aria-selected={library === l}
          className={`tap flex min-h-[34px] flex-1 items-center justify-center gap-1.5 border-0 px-2.5 text-xs first:rounded-l-lg last:rounded-r-lg max-lg:min-h-11 ${library === l ? 'bg-raised font-semibold text-fg' : 'bg-transparent text-muted hover:text-fg'}`}
          data-testid={`review-library-${l}`}
          onClick={() => onChange(l)}
        >
          {libraryName[l]} <span className="tabular-nums" data-testid={`review-count-${l}`}>{counts[l]}</span>
        </button>
      ))}
    </div>
  );
}

/** Steps through unverified verses beside the page they were read from, one library at a time. */
export function ReviewPage() {
  const verses = useStore((s) => s.verses);
  const lessons = useStore((s) => s.lessons);
  const queues = useMemo(() => {
    const sorted = verses
      .filter((v) => v.status === 'unverified')
      .sort((a, b) => a.book_id - b.book_id || a.ref_en.localeCompare(b.ref_en, undefined, { numeric: true }) || a.language.localeCompare(b.language));
    return { verse: sorted.filter((v) => libraryOf(v) === 'verse'), lesson: sorted.filter((v) => libraryOf(v) === 'lesson') };
  }, [verses]);
  const counts = { verse: queues.verse.length, lesson: queues.lesson.length };
  const [library, setLibraryState] = useState<Library>(() => savedLibrary ?? (counts.verse === 0 && counts.lesson > 0 ? 'lesson' : 'verse'));
  const [index, setIndex] = useState(0);
  const setLibrary = (l: Library) => {
    savedLibrary = l;
    setLibraryState(l);
    setIndex(0);
  };
  const queue = queues[library];
  const position = Math.min(index, Math.max(queue.length - 1, 0));
  const verse: Verse | undefined = queue[position];
  const source = verse?.sources[0];
  const lesson = source && lessons.find((l) => l.id === source.lesson_id);

  const [text, setText] = useState('');
  const [reference, setReference] = useState('');
  const [compared, setCompared] = useState(false);
  const [busy, setBusy] = useState(false);

  const verseId = verse?.id;
  useEffect(() => {
    if (!verse) return;
    setText(verse.text);
    setReference(verse.ref_printed);
    setCompared(false);
    if (source) selectLesson(source.lesson_id, source.page);
    // Only when moving to a different verse: a save must not reset what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verseId]);

  if (!verse) {
    const other: Library = library === 'verse' ? 'lesson' : 'verse';
    const inLibrary = verses.filter((v) => libraryOf(v) === library).length;
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center" data-testid="review-page">
        {verses.length > 0 && (
          <div className="mb-6 w-full max-w-sm">
            <LibraryTabs library={library} counts={counts} onChange={setLibrary} />
          </div>
        )}
        <CheckCircle2 size={32} className="text-ok" />
        <h1 className="m-0 mt-3 text-lg font-semibold" data-testid="review-done">
          {verses.length === 0 ? 'No verses to review yet' : counts[other] === 0 ? 'Every verse is verified' : inLibrary === 0 ? `No verses in the ${libraryName[library]} yet` : `Every verse in the ${libraryName[library]} is verified`}
        </h1>
        {counts[other] > 0 && <p className="m-0 mt-1 text-[13px] text-muted" data-testid="review-other">{counts[other]} still to review in the {libraryName[other]}.</p>}
        <button className="btn mt-3" data-testid="review-back" onClick={() => navigate(library === 'verse' ? '/bibles' : '/lesson-verses')}>
          Open {library === 'verse' ? 'the Verse Library' : 'the verses from lessons'}
        </button>
      </div>
    );
  }

  const changed = text.trim() !== verse.text.trim() || reference.trim() !== verse.ref_printed.trim();

  /** Saves any correction first, because verifying locks the verse for good. */
  const saveCorrection = async () => {
    if (!changed) return verse;
    const patch: { text?: string; reference?: string } = {};
    if (text.trim() !== verse.text.trim()) patch.text = text;
    if (reference.trim() !== verse.ref_printed.trim()) patch.reference = reference;
    const updated = await api.correctVerse(verse.id, patch);
    replaceVerse(updated);
    setText(updated.text);
    setReference(updated.ref_printed);
    return updated;
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };

  return (
    <div className="grid h-full grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(320px,440px)] lg:grid-rows-1" data-testid="review-page">
      <div className="min-h-0 min-w-0 border-b border-line lg:border-r lg:border-b-0">
        {lesson ? (
          <PdfViewer lesson={lesson} mark={source && verse.text.trim() ? { text: verse.text, page: source.page } : null} />
        ) : (
          <div className="flex h-full items-center justify-center overflow-auto p-6">
            <div className="card w-full max-w-lg p-5 text-center">
              <span className={`page-tile mx-auto ${verse.import_source ? 'tone-review' : 'tone-archive'}`} aria-hidden="true">
                {verse.import_source ? <FileSpreadsheet size={19} /> : <FileText size={19} />}
              </span>
              <p className="m-0 mt-3 text-[14px] font-semibold" data-testid="review-no-source">
                {verse.import_source ? `Imported from ${verse.import_source}.` : 'This verse has no source page.'}
              </p>
              <p className="m-0 mt-1 text-[13px] text-muted">{verse.import_source ? 'Compare it with your original. The cell as it was in the sheet:' : 'Compare it with where you found it.'}</p>
              {verse.import_source && verse.ocr_raw && (
                <p className="m-0 mt-3 rounded-lg border border-line bg-bg/60 px-3 py-2.5 text-left text-[13px] leading-relaxed whitespace-pre-wrap" data-testid="review-original">{verse.ocr_raw}</p>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="scroll-stable min-h-0 space-y-4 bg-panel/40 p-4" data-testid="review-panel">
        <LibraryTabs library={library} counts={counts} onChange={setLibrary} />
        <div className="flex items-center gap-3">
          <span className="page-tile tone-review !h-9 !w-9" aria-hidden="true"><ListChecks size={17} /></span>
          <h1 className="m-0 min-w-0 flex-1 text-lg font-semibold">Review verses</h1>
          <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-muted tabular-nums" data-testid="review-progress" title={`In the ${libraryName[library]}`}>{position + 1} of {queue.length} to review</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="review-meta">
          <span className="rounded-full border border-line px-2 py-0.5 font-medium">{verse.language === 'tl' ? 'Tagalog' : 'English'}</span>
          {verse.version && <span className="rounded-full border border-line px-2 py-0.5 text-muted">{verse.version}</span>}
          {source && <span className="rounded-full border border-line px-2 py-0.5 text-muted">Page {source.page}</span>}
          {lesson && <span className="min-w-0 truncate text-muted" title={lesson.title}>{lesson.title}</span>}
        </div>
        {verse.ref_note && <p className="m-0 flex items-start gap-1 text-xs text-warn" data-testid="review-note"><ShieldAlert size={13} className="mt-0.5 flex-none" /> {verse.ref_note}</p>}
        <label className="block text-xs text-muted">
          Reference
          <input className="field mt-1" data-testid="review-reference" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="block text-xs text-muted">
          {verse.import_source ? 'Verse text' : 'Verse text, as printed'}
          <textarea className="field mt-1 min-h-44 !text-[14px] leading-relaxed" data-testid="review-text" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <details className="text-xs text-muted">
          <summary className="cursor-pointer" data-testid="review-raw-toggle">{verse.import_source ? 'Show the original cell from the sheet' : 'Show what the scan originally read'}</summary>
          <p className="m-0 mt-1 whitespace-pre-wrap" data-testid="review-raw">{verse.ocr_raw}</p>
        </details>
        <div className="space-y-3 rounded-xl border border-line bg-bg/40 p-3">
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-1" data-testid="review-compared" checked={compared} onChange={(e) => setCompared(e.target.checked)} />
          <span>I compared this with {verse.import_source ? 'the original' : 'the printed page'}, and it matches exactly.</span>
        </label>
        <div className="flex flex-wrap gap-1.5">
          <button
            className="btn btn-primary"
            data-testid="review-verify"
            disabled={busy || !compared || !text.trim()}
            onClick={() =>
              run(async () => {
                const saved = await saveCorrection();
                replaceVerse(await api.verifyVerse(saved.id));
                toast('Verse verified and locked');
              })
            }
          >
            <Lock size={14} /> Verify and lock
          </button>
          <button
            className="btn"
            data-testid="review-save"
            disabled={busy || !changed}
            onClick={() =>
              run(async () => {
                await saveCorrection();
                toast('Correction saved');
              })
            }
          >
            <Save size={14} /> Save correction
          </button>
        </div>
        <p className="m-0 flex items-start gap-1.5 text-xs text-muted"><Lock size={12} className="mt-0.5 flex-none" /> Verifying locks this verse permanently. It can never be edited again, by you or by the AI.</p>
        </div>
        <div className="flex justify-between gap-1.5 border-t border-line pt-4">
          <button className="btn" data-testid="review-prev" disabled={position === 0} onClick={() => setIndex(position - 1)}><ArrowLeft size={14} /> Previous</button>
          <button className="btn" data-testid="review-skip" disabled={position >= queue.length - 1} onClick={() => setIndex(position + 1)}>Skip <ArrowRight size={14} /></button>
        </div>
      </div>
    </div>
  );
}
