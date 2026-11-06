import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FileDown, Loader2, Printer, Sparkles, X } from 'lucide-react';
import type { Verse } from '../api';
import { contextLines, letter, OUTLINE_WORDS, type Outline } from '../lectureOutline';
import { setContextLanguage, useStore } from '../store';
import { backgroundOf, ContextLanguageSwitch, useTagalog } from './VerseContext';

/**
 * The lecture as a document, laid out like the lesson PDFs: the title, the issue and the
 * objectives, then a part for each objective with its verses lettered A., B., C.
 */
export function LectureDocument({ outline, byId, withContext, live }: { outline: Outline; byId: Map<string, Verse>; withContext: boolean; live?: boolean }) {
  const language = useStore((s) => s.contextLanguage);
  const contexts = useStore((s) => s.contexts);
  const scripture = useStore((s) => s.scripture);
  const tagalog = useStore((s) => s.tagalog);
  const words = OUTLINE_WORDS[language];
  const { title, issue, objectives, parts } = outline;
  // Tagalog context is translated when it is shown on screen, as everywhere else.
  const untranslated = withContext && language === 'tl' ? [...new Set(parts.flatMap((p) => p.ids).flatMap((id) => {
    const v = byId.get(id);
    return v ? backgroundOf({ contexts, scripture, tagalog }, v.canonical_key, 'tl').untranslated : [];
  }))] : [];
  const { busy } = useTagalog(untranslated, !!live);
  return (
    <article className="lecture-doc" data-testid="lecture-doc" lang={language === 'tl' ? 'tl' : 'en'}>
      <h1 className="lecture-doc-title" data-testid="doc-title">{title.trim()}</h1>
      {issue.trim() && (
        <section className="lecture-doc-block" data-testid="doc-issue">
          <h2 className="lecture-doc-label">{words.issue}</h2>
          <p>{issue.trim()}</p>
        </section>
      )}
      {objectives.length > 0 && (
        <section className="lecture-doc-block" data-testid="doc-objectives">
          <h2 className="lecture-doc-label">{words.objectives}</h2>
          <ol>
            {objectives.map((o, i) => (
              <li key={i} data-testid="doc-objective">{o}</li>
            ))}
          </ol>
        </section>
      )}
      {parts.map((part, p) => (
        <section key={p} className="lecture-doc-part" data-testid="doc-part">
          {part.label && (
            <h2 className="lecture-doc-heading" data-testid="doc-part-heading">
              {part.objective ? `${part.label}${part.label.endsWith('.') ? '' : ':'} ${part.objective}` : part.label}
            </h2>
          )}
          {part.ids.map((id, i) => {
            const v = byId.get(id);
            if (!v) return null;
            const c = withContext ? contextLines({ contexts, scripture, tagalog }, v, language) : null;
            return (
              <div key={id} className="lecture-doc-point" data-testid="doc-verse">
                <p className="lecture-doc-ref" data-testid="doc-ref">
                  <span className="lecture-doc-letter">{letter(i)}.</span> {v.ref_printed}
                  {v.version && <span className="lecture-doc-version"> {v.version}</span>}
                </p>
                <p className="lecture-doc-text" data-testid="doc-text">{v.text || '—'}</p>
                {c && c.lines.length > 0 && (
                  <div className="lecture-doc-context" data-testid="doc-context">
                    {c.warning && <p className="lecture-doc-warning">{c.warning}</p>}
                    {c.lines.map((line, n) => <p key={n}>{line}</p>)}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
      {live && busy && <p className="lecture-doc-translating no-print" data-testid="doc-translating">Translating the context into Tagalog on this computer…</p>}
    </article>
  );
}

/** The copy that prints: only the lecture, never the app around it. */
export function PrintCopy(props: { outline: Outline; byId: Map<string, Verse>; withContext: boolean }) {
  return createPortal(
    <div className="print-doc" data-testid="print-doc">
      <LectureDocument {...props} />
    </div>,
    document.body,
  );
}

/** The lecture as it will print, before printing or downloading it. */
export function LecturePreview({ outline, byId, withContext, onContext, onClose, onWord, exporting }: { outline: Outline; byId: Map<string, Verse>; withContext: boolean; onContext: (on: boolean) => void; onClose: () => void; onWord: () => void; exporting: boolean }) {
  const language = useStore((s) => s.contextLanguage);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  const verseCount = outline.parts.reduce((n, p) => n + p.ids.length, 0);
  return createPortal(
    <div className="no-print fade-in fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Preview lecture" data-testid="preview-dialog">
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-[15px] font-semibold">Preview lecture</h2>
          <p className="m-0 text-xs text-muted" data-testid="preview-summary">
            {outline.objectives.length} {outline.objectives.length === 1 ? 'objective' : 'objectives'} · {verseCount} {verseCount === 1 ? 'verse' : 'verses'}
          </p>
        </div>
        <ContextLanguageSwitch language={language} onChange={setContextLanguage} testId="preview-language" />
        <button type="button" role="switch" aria-checked={withContext} className="btn" data-testid="preview-context" onClick={() => onContext(!withContext)}>
          <span className={`switch ${withContext ? 'is-on' : ''}`} aria-hidden="true" />
          <Sparkles size={14} /> AI context
        </button>
        <button className="btn" data-testid="preview-word" disabled={exporting} onClick={onWord}>
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />} Word
        </button>
        <button className="btn btn-primary" data-testid="preview-print" onClick={() => window.print()}>
          <Printer size={14} /> Print or save as PDF
        </button>
        <button className="icon-btn" aria-label="Close preview" data-testid="preview-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-6 sm:px-6" data-testid="preview-scroll">
        <div className="lecture-paper mx-auto">
          <LectureDocument outline={outline} byId={byId} withContext={withContext} live />
        </div>
      </div>
    </div>,
    document.body,
  );
}
