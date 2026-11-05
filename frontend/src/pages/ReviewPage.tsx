import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Lock, Save, ShieldAlert } from 'lucide-react';
import { api, type Verse } from '../api';
import { PdfViewer } from '../components/PdfViewer';
import { errorText, getState, navigate, selectLesson, setState, toast, useStore } from '../store';

const replaceVerse = (v: Verse) => setState({ verses: getState().verses.map((x) => (x.id === v.id ? v : x)) });

/** Steps through unverified verses beside the page they were read from. */
export function ReviewPage() {
  const verses = useStore((s) => s.verses);
  const lessons = useStore((s) => s.lessons);
  const queue = useMemo(
    () => verses.filter((v) => v.status === 'unverified').sort((a, b) => a.book_id - b.book_id || a.ref_en.localeCompare(b.ref_en, undefined, { numeric: true }) || a.language.localeCompare(b.language)),
    [verses],
  );
  const [index, setIndex] = useState(0);
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
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center" data-testid="review-page">
        <CheckCircle2 size={32} className="text-ok" />
        <h1 className="m-0 mt-3 text-lg font-semibold" data-testid="review-done">{verses.length === 0 ? 'No verses to review yet' : 'Every verse is verified'}</h1>
        <button className="btn mt-3" data-testid="review-back" onClick={() => navigate('/bibles')}>Open Bibles Library</button>
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
        {lesson ? <PdfViewer lesson={lesson} /> : <p className="p-6 text-center text-[13px] text-muted" data-testid="review-no-source">{verse.import_source ? `Imported from ${verse.import_source}. Compare it with your original.` : 'This verse has no source page.'}</p>}
      </div>
      <div className="scroll-stable min-h-0 space-y-3 p-3" data-testid="review-panel">
        <div className="flex items-center justify-between gap-2">
          <h1 className="m-0 text-lg font-semibold">Review verses</h1>
          <span className="text-xs text-muted tabular-nums" data-testid="review-progress">{position + 1} of {queue.length} to review</span>
        </div>
        <p className="m-0 text-xs text-muted">
          {verse.language === 'tl' ? 'Tagalog' : 'English'}
          {verse.version ? ` · ${verse.version}` : ''}
          {source ? ` · page ${source.page}` : ''}
          {lesson ? ` · ${lesson.title}` : ''}
        </p>
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
        <p className="m-0 text-xs text-muted">Verifying locks this verse permanently. It can never be edited again, by you or by the AI.</p>
        <div className="flex justify-between gap-1.5 border-t border-line pt-3">
          <button className="btn" data-testid="review-prev" disabled={position === 0} onClick={() => setIndex(position - 1)}><ArrowLeft size={14} /> Previous</button>
          <button className="btn" data-testid="review-skip" disabled={position >= queue.length - 1} onClick={() => setIndex(position + 1)}>Skip <ArrowRight size={14} /></button>
        </div>
      </div>
    </div>
  );
}
