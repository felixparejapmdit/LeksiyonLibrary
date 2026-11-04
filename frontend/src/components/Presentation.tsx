import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Info, X } from 'lucide-react';
import type { Verse } from '../api';
import { useStore } from '../store';

export interface Slide {
  verse: Verse;
  objective: string;
}

/** One reference at a time, in both languages, for teaching from a screen. */
export function PresentationMode({ title, slides, onClose }: { title: string; slides: Slide[]; onClose: () => void }) {
  const verses = useStore((s) => s.verses);
  const contexts = useStore((s) => s.contexts);
  const [index, setIndex] = useState(0);
  const [showContext, setShowContext] = useState(false);
  const next = useCallback(() => setIndex((i) => Math.min(i + 1, slides.length - 1)), [slides.length]);
  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  useEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        prev();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [next, prev, onClose]);

  const slide = slides[index];
  if (!slide) return null;
  const { verse, objective } = slide;
  // The chosen edition first, then the same reference in the other language.
  const editions = [verse, ...verses.filter((v) => v.canonical_key === verse.canonical_key && v.language !== verse.language && v.text)];
  const context = contexts[verse.canonical_key];

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg text-fg" role="dialog" aria-modal="true" aria-label={`Presenting ${title}`} data-testid="present">
      <div className="flex flex-none items-center gap-2 border-b border-line px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted" data-testid="present-title">{title}</span>
        <span className="text-[13px] text-muted tabular-nums" data-testid="present-count">{index + 1} / {slides.length}</span>
        <button className="icon-btn" aria-label={showContext ? 'Hide context' : 'Show context'} aria-pressed={showContext} data-testid="present-context" disabled={!context} onClick={() => setShowContext((s) => !s)}><Info size={18} /></button>
        <button className="icon-btn" aria-label="Exit presentation" data-testid="present-exit" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6 lg:p-12">
        <div className="mx-auto max-w-6xl">
          {objective && <p className="m-0 mb-2 text-lg text-accent2" data-testid="present-objective">{objective}</p>}
          <h2 className="m-0 mb-6 text-3xl font-semibold lg:text-5xl" data-testid="present-reference">{verse.ref_printed}</h2>
          <div className={`grid grid-cols-1 gap-8 ${editions.length > 1 ? 'lg:grid-cols-2' : ''}`}>
            {editions.map((v) => (
              <section key={v.id} data-testid="present-edition" data-language={v.language}>
                <p className="m-0 mb-2 text-sm font-semibold text-muted">{v.language === 'tl' ? 'Tagalog' : 'English'}{v.version ? ` · ${v.version}` : ''}</p>
                <p className="m-0 text-2xl leading-relaxed whitespace-pre-wrap lg:text-3xl" data-testid="present-text">{v.text || 'Reference only.'}</p>
              </section>
            ))}
          </div>
          {showContext && context && (
            <div className="mt-8 border-t border-line pt-4 text-lg text-accent2" data-testid="present-context-text">
              {!context.reviewed && <p className="m-0 mb-1 text-sm font-semibold">AI context, not scripture. Review before use.</p>}
              {context.speaker && <p className="m-0"><span className="font-semibold">Speaker: </span>{context.speaker}</p>}
              {context.context && <p className="m-0"><span className="font-semibold">Context: </span>{context.context}</p>}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-none justify-between gap-2 border-t border-line p-3">
        <button className="btn" data-testid="present-prev" disabled={index === 0} onClick={prev}><ArrowLeft size={16} /> Previous</button>
        <button className="btn btn-primary" data-testid="present-next" disabled={index >= slides.length - 1} onClick={next}>Next <ArrowRight size={16} /></button>
      </div>
    </div>,
    document.body,
  );
}
