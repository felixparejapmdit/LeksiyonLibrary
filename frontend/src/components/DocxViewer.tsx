import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, ClipboardCheck, Crosshair, Download, FileText, Highlighter, Languages, Loader2, Maximize, SearchX, ZoomIn, ZoomOut } from 'lucide-react';
import { renderAsync } from 'docx-preview';
import { lessonFileUrl, type Lesson } from '../api';
import { selectLesson, setState, useStore } from '../store';
import { LessonSummary } from './LessonSummary';
import type { VerseMark } from './PdfViewer';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

/** Match across Word runs without changing the stored or displayed wording. */
function textIndex(text: string) {
  let normalized = '';
  const offsets: number[] = [];
  let offset = 0;
  for (const char of text) {
    const folded = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const letter of folded) if (/[\p{L}\p{N}]/u.test(letter)) {
      normalized += letter;
      for (let i = 0; i < letter.length; i++) offsets.push(offset);
    }
    offset += char.length;
  }
  offsets.push(text.length);
  return { normalized, offsets };
}

function highlightVerse(pages: HTMLElement[], text: string, preferredPage: number): { page: number; element: HTMLElement } | null {
  for (const page of pages) for (const mark of page.querySelectorAll('mark[data-verse-mark]')) {
    const parent = mark.parentNode;
    mark.replaceWith(...mark.childNodes);
    parent?.normalize();
  }
  const needle = textIndex(text).normalized;
  if (!needle) return null;
  const nodes: { node: Text; start: number; end: number; offsets: number[]; page: number }[] = [];
  let combined = '';
  pages.forEach((page, index) => {
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.parentElement?.closest('style,script')) continue;
      const part = textIndex(node.textContent ?? '');
      if (!part.normalized) continue;
      nodes.push({ node, start: combined.length, end: combined.length + part.normalized.length, offsets: part.offsets, page: index + 1 });
      combined += part.normalized;
    }
  });
  const preferredNodes = nodes.filter((part) => part.page === preferredPage);
  const preferredStart = preferredNodes[0]?.start ?? 0;
  const preferredEnd = preferredNodes.at(-1)?.end ?? 0;
  const preferredMatch = combined.slice(preferredStart, preferredEnd).indexOf(needle);
  const start = preferredMatch >= 0 ? preferredStart + preferredMatch : combined.indexOf(needle);
  if (start < 0) return null;
  const end = start + needle.length;
  let first: { page: number; element: HTMLElement } | null = null;
  for (const part of nodes) {
    if (part.end <= start || part.start >= end) continue;
    const from = part.offsets[Math.max(0, start - part.start)];
    const to = part.offsets[Math.min(part.end, end) - part.start];
    const target = from ? part.node.splitText(from) : part.node;
    if (to - from < target.length) target.splitText(to - from);
    const mark = document.createElement('mark');
    mark.dataset.verseMark = 'true';
    target.replaceWith(mark);
    mark.append(target);
    first ??= { page: part.page, element: mark };
  }
  return first;
}

export default function DocxViewer({ lesson, onBack, embedded, mark }: {
  lesson: Lesson; onBack?: () => void; embedded?: boolean; mark?: VerseMark | null;
}) {
  const page = useStore((s) => s.viewerPage);
  const counterpart = useStore((s) => s.lessons.find((l) => l.id !== lesson.id && l.language !== lesson.language
    && l.lesson_date && l.lesson_date === lesson.lesson_date && l.category === lesson.category));
  const host = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLElement[]>([]);
  const marked = useRef<HTMLElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [pageCount, setPageCount] = useState(lesson.page_count || 1);
  const [size, setSize] = useState({ w: 816, h: 1056 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitZoom, setFitZoom] = useState(1);
  const [foundPage, setFoundPage] = useState<number | null>(null);
  const [markReady, setMarkReady] = useState(false);
  const [showMark, setShowMark] = useState(0);
  const currentPage = Math.min(Math.max(1, page), pageCount);
  const effectiveZoom = zoom ?? fitZoom;
  const url = lessonFileUrl(lesson.id);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    // Word styles are isolated from the app and from other open document previews.
    const base = document.createElement('style');
    base.textContent = ':host{display:block;color:#111;color-scheme:light;font:12pt "Times New Roman",serif;line-height:normal} section.word-doc{margin:0!important;box-shadow:none!important;background:white} mark[data-verse-mark]{background:#ffe38a;color:inherit;border-radius:2px;box-shadow:0 0 0 1px #d8a523} a{color:inherit;pointer-events:none}';
    const styles = document.createElement('div');
    const body = document.createElement('div');
    shadow.replaceChildren(base, styles, body);
    const abort = new AbortController();
    let alive = true;
    setLoaded(false); setError(false);
    fetch(url, { credentials: 'same-origin', signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Document request failed');
        return response.arrayBuffer();
      })
      .then((data) => renderAsync(data, body, styles, {
        className: 'word-doc', inWrapper: false, breakPages: true,
        ignoreLastRenderedPageBreak: false, useBase64URL: true,
        renderAltChunks: false, renderChanges: false, renderComments: false,
      }))
      .then(() => {
        if (!alive) return;
        pages.current = [...body.querySelectorAll<HTMLElement>('section.word-doc')];
        if (!pages.current.length) throw new Error('No document content');
        // Links are preserved as visible text; opening the original is an explicit download.
        for (const link of body.querySelectorAll('a')) link.removeAttribute('href');
        setPageCount(pages.current.length);
        setLoaded(true);
      })
      .catch(() => { if (alive) setError(true); });
    return () => {
      alive = false;
      abort.abort();
      pages.current = [];
      shadow.replaceChildren();
    };
  }, [url]);

  useLayoutEffect(() => {
    if (!loaded) return;
    pages.current.forEach((section, index) => { section.style.display = index + 1 === currentPage ? '' : 'none'; });
    const active = pages.current[currentPage - 1];
    if (!active) return;
    const measure = () => {
      const next = { w: active.offsetWidth || 816, h: Math.max(active.offsetHeight, active.scrollHeight, 1) };
      setSize((previous) => previous.w === next.w && previous.h === next.h ? previous : next);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(active);
    scroll.current?.scrollTo({ top: 0, left: 0 });
    return () => resize.disconnect();
  }, [loaded, currentPage]);

  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    const measure = () => {
      const style = getComputedStyle(viewport);
      const available = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (available > 0) setFitZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, available / size.w)));
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(viewport);
    return () => resize.disconnect();
  }, [size.w]);

  useEffect(() => {
    setMarkReady(false); setFoundPage(null); marked.current = null;
    if (!loaded) return;
    const found = highlightVerse(pages.current, mark?.text ?? '', mark?.page ?? 1);
    marked.current = found?.element ?? null;
    setFoundPage(found?.page ?? null);
    setMarkReady(true);
    if (found) setState({ viewerPage: found.page });
  }, [loaded, mark?.text, mark?.page]);

  useEffect(() => {
    const target = marked.current;
    const viewport = scroll.current;
    if (!target || !viewport || currentPage !== foundPage) return;
    const frame = requestAnimationFrame(() => {
      const targetBox = target.getBoundingClientRect();
      const viewBox = viewport.getBoundingClientRect();
      viewport.scrollTo({ top: viewport.scrollTop + targetBox.top - viewBox.top - viewport.clientHeight / 3,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [currentPage, foundPage, effectiveZoom, showMark]);

  const changeZoom = (delta: number) => setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((effectiveZoom + delta) * 100) / 100)));
  return <section className="flex h-full min-w-0 flex-col bg-bg" aria-label="Word document viewer" data-testid="docx-viewer" data-lesson={lesson.id}>
    <div className="no-print flex min-h-12 flex-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-panel px-3 py-2">
      {onBack && <button className="icon-btn" aria-label="Back to lessons" data-testid="viewer-back" onClick={onBack}><ArrowLeft size={18} /></button>}
      <span className="mr-auto inline-flex items-center gap-1.5 text-xs font-semibold text-muted"><FileText size={15} /> DOCX</span>
      {counterpart && !embedded && <button className="btn" data-testid="viewer-counterpart" onClick={() => selectLesson(counterpart.id, 1)}>
        <Languages size={14} /> {counterpart.language === 'tl' ? 'Tagalog' : 'English'}
      </button>}
      <div className="flex items-center gap-0.5" role="group" aria-label="Document pages">
        <button className="icon-btn" aria-label="Previous page" data-testid="viewer-prev" disabled={!loaded || currentPage <= 1} onClick={() => setState({ viewerPage: currentPage - 1 })}><ChevronLeft size={16} /></button>
        <span className="min-w-11 text-center text-xs tabular-nums" data-testid="viewer-page">{currentPage} / {pageCount}</span>
        <button className="icon-btn" aria-label="Next page" data-testid="viewer-next" disabled={!loaded || currentPage >= pageCount} onClick={() => setState({ viewerPage: currentPage + 1 })}><ChevronRight size={16} /></button>
      </div>
      <div className="flex items-center gap-0.5" role="group" aria-label="Document zoom">
        <button className="icon-btn" aria-label="Zoom out" data-testid="viewer-zoom-out" disabled={effectiveZoom <= MIN_ZOOM} onClick={() => changeZoom(-0.1)}><ZoomOut size={16} /></button>
        <span className="min-w-11 text-center text-xs tabular-nums" data-testid="viewer-zoom">{Math.round(effectiveZoom * 100)}%</span>
        <button className="icon-btn" aria-label="Zoom in" data-testid="viewer-zoom-in" disabled={effectiveZoom >= MAX_ZOOM} onClick={() => changeZoom(0.1)}><ZoomIn size={16} /></button>
        <button className="icon-btn" aria-label="Fit to width" data-testid="viewer-fit" onClick={() => setZoom(null)}><Maximize size={15} /></button>
      </div>
      <a className="icon-btn" aria-label="Download original DOCX" href={lessonFileUrl(lesson.id, true)} data-testid="viewer-download"><Download size={16} /></a>
    </div>
    {!embedded && lesson.needs_check && <div className="no-print flex flex-none flex-wrap items-center gap-2 border-b border-line bg-raised px-3 py-1.5 text-[13px]" role="status" data-testid="viewer-needs-check">
      <ClipboardCheck size={14} className="flex-none text-warn" /><span className="min-w-0 flex-1">Not checked yet. Compare what was read from this DOCX before relying on it.</span>
      <button className="btn !min-h-7 max-lg:!min-h-11" data-testid="viewer-check" onClick={() => setState({ editingLessonId: lesson.id })}>Check now</button>
    </div>}
    {!embedded && <LessonSummary lesson={lesson} />}
    <p className="m-0 flex-none border-b border-line px-3 py-1.5 text-[11px] leading-relaxed text-muted" data-testid="docx-preview-note">Word preview. Page layout may differ from Microsoft Word; download the original for its exact layout.</p>
    {mark?.text && <div className="no-print flex min-h-9 flex-none flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1 text-xs" role="status" data-testid="viewer-mark-status" data-state={!markReady ? 'finding' : foundPage ? 'found' : 'missing'}>
      {!markReady ? <><Loader2 size={13} className="animate-spin" /> Finding this verse…</> : foundPage ? <>
        <Highlighter size={13} className="text-warn" /><span className="min-w-0 flex-1">This verse is highlighted in the document.</span>
        <button className="btn !min-h-7 max-lg:!min-h-11" data-testid="viewer-mark-show" onClick={() => { setState({ viewerPage: foundPage }); setShowMark((n) => n + 1); }}><Crosshair size={13} /> Show it</button>
      </> : <><SearchX size={13} /><span className="min-w-0 flex-1 text-muted">This verse could not be matched. Compare it with the original document by eye.</span></>}
    </div>}
    <div ref={scroll} className="min-h-0 flex-1 overflow-auto p-3 sm:p-4" data-testid="viewer-scroll" style={{ overscrollBehavior: 'contain', scrollbarGutter: 'stable' }}>
      {error && <p className="mx-auto mt-10 max-w-xs text-center text-sm text-muted" data-testid="viewer-error">This DOCX could not be previewed. Download the original to open it in Word.</p>}
      {!error && !loaded && <p className="flex justify-center gap-2 text-sm text-muted" role="status"><Loader2 size={16} className="animate-spin" /> Opening Word document…</p>}
      <div className="relative mx-auto" style={{ width: size.w * effectiveZoom, height: loaded ? size.h * effectiveZoom : 0, visibility: loaded && !error ? 'visible' : 'hidden' }} data-testid="viewer-frame">
        <div ref={host} data-testid="docx-content" style={{ width: size.w, transform: `scale(${effectiveZoom})`, transformOrigin: 'top left' }} />
      </div>
    </div>
  </section>;
}
