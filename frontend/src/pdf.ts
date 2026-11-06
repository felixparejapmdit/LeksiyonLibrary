import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

type Pdfjs = typeof import('pdfjs-dist');

let lib: Promise<Pdfjs> | null = null;

/** Loaded once and warmed at idle, so the first lesson opens without a pause. */
export function loadPdfjs() {
  lib ??= import('pdfjs-dist').then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  return lib;
}

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
  }).promise;
}

// Keeps recently opened documents ready so switching lessons is instant.
const MAX_DOCS = 10;
const docs = new Map<string, Promise<PDFDocumentProxy>>();

export function lessonDocument(url: string): Promise<PDFDocumentProxy> {
  const existing = docs.get(url);
  if (existing) {
    docs.delete(url);
    docs.set(url, existing);
    return existing;
  }
  const loading = fetch(url, { credentials: 'same-origin' })
    .then((res) => {
      if (!res.ok) throw new Error(`PDF request failed (${res.status})`);
      return res.arrayBuffer();
    })
    .then((buf) => openPdf(new Uint8Array(buf)));
  docs.set(url, loading);
  loading.catch(() => docs.delete(url));
  while (docs.size > MAX_DOCS) {
    const oldest = docs.keys().next().value as string;
    const victim = docs.get(oldest);
    docs.delete(oldest);
    victim?.then((d) => d.loadingTask.destroy()).catch(() => {});
  }
  return loading;
}

export function forgetDocuments() {
  for (const d of docs.values()) d.then((x) => x.loadingTask.destroy()).catch(() => {});
  docs.clear();
  pageCache.clear();
}

// Finished page renders, reused when returning to a page at the same zoom.
const MAX_PAGES = 12;
const pageCache = new Map<string, HTMLCanvasElement>();

export function cachedPage(key: string) {
  const c = pageCache.get(key);
  if (c) {
    pageCache.delete(key);
    pageCache.set(key, c);
  }
  return c;
}

export function rememberPage(key: string, canvas: HTMLCanvasElement) {
  pageCache.set(key, canvas);
  while (pageCache.size > MAX_PAGES) pageCache.delete(pageCache.keys().next().value as string);
}

export async function renderToCanvas(doc: PDFDocumentProxy, pageNumber: number, scale: number, rotation: number, signal?: { cancelled: boolean }) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas is not available');
  const task = page.render({ canvas, canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]);
  if (signal) {
    const poll = setInterval(() => {
      if (signal.cancelled) task.cancel();
    }, 30);
    try {
      await task.promise;
    } finally {
      clearInterval(poll);
    }
  } else {
    await task.promise;
  }
  return canvas;
}
