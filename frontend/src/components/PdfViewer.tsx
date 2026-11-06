import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ArrowLeft, ChevronLeft, ChevronRight, ClipboardCheck, ExternalLink, FileText, Languages, Maximize, Pencil, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { lessonFileUrl, type Lesson } from '../api';
import { cachedPage, lessonDocument, rememberPage, renderToCanvas } from '../pdf';
import { selectLesson, setState, useStore } from '../store';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const STEP = 0.1;

function storedOpen() {
  try {
    return localStorage.getItem('lv.summary') === '1';
  } catch {
    return false;
  }
}

/** The lesson's issue and objectives, as read from the PDF and corrected by the user. */
function LessonSummary({ lesson }: { lesson: Lesson }) {
  const [open, setOpen] = useState(storedOpen);
  const tagalog = lesson.language === 'tl';
  const empty = !lesson.issue && lesson.objectives.length === 0;
  return (
    <details
      className="no-print flex-none border-b border-line bg-panel text-[13px]"
      data-testid="lesson-summary"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        try {
          localStorage.setItem('lv.summary', next ? '1' : '0');
        } catch {
          /* private mode: it still toggles for this session */
        }
      }}
    >
      <summary className="tap cursor-pointer px-3 py-1.5 text-xs font-semibold text-muted max-lg:py-3" data-testid="lesson-summary-toggle">
        {tagalog ? 'Isyu at Mga Layunin' : 'Issue and Objectives'}
      </summary>
      <div className="max-h-[40vh] overflow-auto px-3 pb-2" data-testid="lesson-summary-body">
        {empty ? (
          <p className="m-0 text-muted" data-testid="lesson-summary-empty">None found in this PDF. You can add them.</p>
        ) : (
          <>
            {lesson.issue && (
              <>
                <h3 className="m-0 text-xs font-semibold">{tagalog ? 'Isyu' : 'Issue'}</h3>
                <p className="m-0 mb-2 leading-relaxed" data-testid="lesson-issue">{lesson.issue}</p>
              </>
            )}
            {lesson.objectives.length > 0 && (
              <>
                <h3 className="m-0 text-xs font-semibold">{tagalog ? 'Mga Layunin' : 'Objectives'}</h3>
                <ol className="m-0 mb-2 pl-5 leading-relaxed" data-testid="lesson-objectives">
                  {lesson.objectives.map((o, i) => <li key={i} data-testid="lesson-objective">{o}</li>)}
                </ol>
              </>
            )}
          </>
        )}
        <div className="flex flex-wrap gap-1.5">
          <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="lesson-summary-edit" onClick={() => setState({ editingLessonId: lesson.id })}>
            <Pencil size={13} /> {empty ? 'Add' : 'Edit'}
          </button>
        </div>
      </div>
    </details>
  );
}

/**
 * Pages render into an offscreen canvas and replace the visible one in a single
 * step, so the page on screen is never blank. Zoom resizes the current image
 * immediately via CSS, then swaps in a sharp render when it is ready.
 */
/** `embedded` is the copy beside the check dialog's form, which already shows the lesson's details. */
export function PdfViewer({ lesson, onBack, embedded }: { lesson: Lesson; onBack?: () => void; embedded?: boolean }) {
  const page = useStore((s) => s.viewerPage);
  const counterpart = useStore((s) =>
    s.lessons.find((l) => l.id !== lesson.id && l.language !== lesson.language && l.lesson_date && l.lesson_date === lesson.lesson_date && l.category === lesson.category),
  );
  const url = lessonFileUrl(lesson.id);
  const [loaded, setLoaded] = useState<{ url: string; doc: PDFDocumentProxy } | null>(null);
  // A document only counts for the lesson it was opened for. Otherwise, while the next
  // lesson loads, the previous PDF would be rendered and cached under the new lesson's key.
  const doc = loaded?.url === url ? loaded.doc : null;
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null); // null means fit to width.
  const [fitZoom, setFitZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pageSize, setPageSize] = useState({ w: 595, h: 842 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const effectiveZoom = zoom ?? fitZoom;
  const pageCount = doc?.numPages ?? lesson.page_count;
  const currentPage = Math.min(Math.max(1, page), Math.max(1, pageCount));

  const setPage = useCallback((p: number) => setState({ viewerPage: p }), []);

  useEffect(() => {
    let alive = true;
    setError(false);
    lessonDocument(url)
      .then((d) => {
        if (alive) setLoaded({ url, doc: d });
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [url]);

  // Natural size of the current page, used for fit-to-width.
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    doc.getPage(currentPage).then((p) => {
      if (!alive) return;
      const vp = p.getViewport({ scale: 1, rotation: (p.rotate + rotation) % 360 });
      setPageSize({ w: vp.width, h: vp.height });
    });
    return () => {
      alive = false;
    };
  }, [doc, currentPage, rotation]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // The scrollbar's space is always reserved (scrollbar-gutter), so its appearing
    // cannot change this width. Otherwise fit-to-width could oscillate: scrollbar
    // appears, page shrinks, scrollbar goes, page grows, on every frame.
    const measure = () => {
      const available = el.clientWidth - 32;
      if (available > 0) setFitZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, available / pageSize.w)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageSize.w]);

  // Sharp render, settled so that dragging a pane or holding zoom stays smooth.
  useEffect(() => {
    if (!doc || currentPage > doc.numPages) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.round(effectiveZoom * dpr * 100) / 100;
    const key = `${url}|${currentPage}|${scale}|${rotation}`;
    const signal = { cancelled: false };

    const show = (source: HTMLCanvasElement) => {
      const target = canvasRef.current;
      if (!target) return;
      target.width = source.width;
      target.height = source.height;
      target.getContext('2d', { alpha: false })?.drawImage(source, 0, 0);
      target.dataset.renderedKey = key;
    };

    const hit = cachedPage(key);
    if (hit) {
      show(hit);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const rendered = await renderToCanvas(doc, currentPage, scale, rotation, signal);
        if (signal.cancelled) return;
        rememberPage(key, rendered);
        show(rendered);
        // Prepare the next page while idle so "next" responds immediately.
        const next = currentPage + 1;
        const nextKey = `${url}|${next}|${scale}|${rotation}`;
        if (next <= doc.numPages && !cachedPage(nextKey)) {
          window.requestIdleCallback?.(() => {
            if (signal.cancelled) return;
            renderToCanvas(doc, next, scale, rotation, signal)
              .then((c) => {
                if (!signal.cancelled) rememberPage(nextKey, c);
              })
              .catch(() => {});
          });
        }
      } catch {
        /* A cancelled render is expected whenever the page or zoom changes. */
      }
    }, 40);
    return () => {
      signal.cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, url, currentPage, effectiveZoom, rotation]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [currentPage, url]);

  const changeZoom = (delta: number) => setZoom(Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, effectiveZoom + delta)) * 10) / 10);

  return (
    <section className="flex h-full min-w-0 flex-col bg-bg" aria-label="PDF viewer" data-testid="pdf-viewer" data-lesson={lesson.id}>
      <div className="no-print flex min-h-12 flex-none flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-1">
        {onBack && (
          <button className="icon-btn" aria-label="Back to lessons" data-testid="viewer-back" onClick={onBack}>
            <ArrowLeft size={18} />
          </button>
        )}
        <FileText size={14} className="mx-1 text-muted max-sm:hidden" aria-hidden="true" />
        <span className="mr-auto" />
        {counterpart && !embedded && (
          <button className="btn" data-testid="viewer-counterpart" onClick={() => selectLesson(counterpart.id, 1)}>
            <Languages size={14} /> {counterpart.language === 'tl' ? 'Tagalog' : 'English'}
          </button>
        )}
        <button className="icon-btn" aria-label="Previous page" data-testid="viewer-prev" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
          <ChevronLeft size={16} />
        </button>
        <span className="min-w-11 text-center text-xs tabular-nums" data-testid="viewer-page">{currentPage} / {pageCount}</span>
        <button className="icon-btn" aria-label="Next page" data-testid="viewer-next" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>
          <ChevronRight size={16} />
        </button>
        <button className="icon-btn" aria-label="Zoom out" data-testid="viewer-zoom-out" disabled={effectiveZoom <= MIN_ZOOM} onClick={() => changeZoom(-STEP)}>
          <ZoomOut size={16} />
        </button>
        <span className="min-w-11 text-center text-xs tabular-nums" data-testid="viewer-zoom">{Math.round(effectiveZoom * 100)}%</span>
        <button className="icon-btn" aria-label="Zoom in" data-testid="viewer-zoom-in" disabled={effectiveZoom >= MAX_ZOOM} onClick={() => changeZoom(STEP)}>
          <ZoomIn size={16} />
        </button>
        <button className="icon-btn" aria-label="Fit to width" data-testid="viewer-fit" onClick={() => setZoom(null)}>
          <Maximize size={15} />
        </button>
        <button className="icon-btn" aria-label="Rotate page" data-testid="viewer-rotate" onClick={() => setRotation((r) => (r + 90) % 360)}>
          <RotateCw size={15} />
        </button>
        <a className="icon-btn" aria-label="Open PDF in a new tab" href={url} target="_blank" rel="noopener" data-testid="viewer-open">
          <ExternalLink size={15} />
        </a>
      </div>
      {!embedded && lesson.needs_check && (
        <div className="no-print flex flex-none flex-wrap items-center gap-2 border-b border-line bg-raised px-3 py-1.5 text-[13px]" role="status" data-testid="viewer-needs-check">
          <ClipboardCheck size={14} className="flex-none text-warn" />
          <span className="min-w-0 flex-1">Not checked yet. Compare what was read from this PDF before relying on it.</span>
          <button className="btn !min-h-7 max-lg:!min-h-11" data-testid="viewer-check" onClick={() => setState({ editingLessonId: lesson.id })}>Check now</button>
        </div>
      )}
      {!embedded && <LessonSummary lesson={lesson} />}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4" data-testid="viewer-scroll" style={{ overscrollBehavior: 'contain', scrollbarGutter: 'stable' }}>
        {error ? (
          <p className="m-auto mt-10 max-w-xs text-center text-muted" data-testid="viewer-error">This PDF could not be opened. Try downloading it instead.</p>
        ) : (
          <canvas
            ref={canvasRef}
            data-testid="viewer-canvas"
            className="mx-auto block rounded-sm bg-white"
            aria-label={`Page ${currentPage} of ${lesson.title}`}
            role="img"
            style={{
              width: Math.floor(pageSize.w * effectiveZoom),
              height: Math.floor(pageSize.h * effectiveZoom),
            }}
          />
        )}
      </div>
    </section>
  );
}
