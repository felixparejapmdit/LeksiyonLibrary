import { api, ApiError, type Lesson, type UploadTarget } from './api';
import { loadPdfjs, openPdf, renderToCanvas } from './pdf';
import { getState, refreshAll, selectLesson, setState, toast, type UploadItem } from './store';

type OcrWorker = { recognize: (image: Blob) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> };

let worker: Promise<OcrWorker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 0;
const pending: { item: UploadItem; file: File }[] = [];
let running = false;

const MIN_TEXT_CHARS = 30;
const OCR_FALLBACK_SCALE = 3.5;

/** The OCR engine runs in its own Web Worker, so the UI stays responsive. */
function ocrWorker() {
  clearTimeout(idleTimer);
  worker ??= import('tesseract.js').then(
    ({ createWorker }) =>
      createWorker(['tgl', 'eng'], 1, {
        workerPath: '/ocr/worker.min.js',
        corePath: '/ocr/',
        langPath: '/ocr',
        gzip: true,
        workerBlobURL: false,
      }) as unknown as Promise<OcrWorker>,
  );
  return worker;
}

function releaseWorkerSoon() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    worker?.then((w) => w.terminate()).catch(() => {});
    worker = null;
  }, 60_000);
}

function patch(id: number, p: Partial<UploadItem>) {
  setState({ uploads: getState().uploads.map((u) => (u.id === id ? { ...u, ...p } : u)) });
}

/** A folder can hold anything, so only its PDFs are taken. */
export function enqueueFolder(files: Iterable<File>, target: UploadTarget = getState().uploadTarget) {
  const all = [...files];
  const pdfs = all.filter((f) => /\.pdf$/i.test(f.name));
  const others = all.length - pdfs.length;
  if (pdfs.length === 0) {
    toast('That folder has no PDF files.', 'error');
    return;
  }
  toast(`Adding ${pdfs.length} PDF ${pdfs.length === 1 ? 'file' : 'files'}${others ? `, skipping ${others} other ${others === 1 ? 'file' : 'files'}` : ''}`);
  enqueueFiles(pdfs, target);
}

/** What was missing after reading a lesson, so it can be checked by hand. */
function needsAttention(lesson: Lesson, verseCount: number, unread: { page: number; text: string }[]) {
  const missing = [
    ...(verseCount === 0 ? ['no verses'] : []),
    // A pastoral visit has no issue or objectives printed.
    ...(lesson.category !== 'pastoral' && !lesson.issue && lesson.objectives.length === 0 ? ['no issue or objectives'] : []),
    ...(!lesson.lesson_date && !lesson.date_label ? ['no date'] : []),
  ];
  const notes = missing.length ? [`Check this lesson: ${missing.join(', ')} found.`] : [];
  // A reference the scan garbled is left out rather than guessed; it can be added by hand.
  for (const u of unread) notes.push(`A reference on page ${u.page} could not be read, so its verse was not added: "${u.text}". Add it by hand.`);
  return notes.length ? notes.join(' ') : undefined;
}

/** Files go where the upload dialog was opened from: the Lesson Library or Pastoral Visits. */
export function enqueueFiles(files: Iterable<File>, target: UploadTarget = getState().uploadTarget) {
  const items: UploadItem[] = [];
  for (const file of files) {
    const item: UploadItem = { id: ++nextId, name: file.name, status: 'queued', message: 'Waiting', progress: 0, target };
    items.push(item);
    pending.push({ item, file });
  }
  setState({ uploads: [...getState().uploads, ...items] });
  void run();
}

async function run() {
  if (running) return;
  running = true;
  while (pending.length) {
    const job = pending.shift()!;
    await ingest(job.item.id, job.file, job.item.target);
  }
  running = false;
  releaseWorkerSoon();
}

function pageTextFromItems(items: { str?: string; transform?: number[]; hasEOL?: boolean }[]) {
  let out = '';
  let lastY: number | null = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const y = it.transform?.[5] ?? 0;
    if (lastY !== null && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
    out += it.str;
    if (it.hasEOL) out += '\n';
    lastY = y;
  }
  return out;
}

/**
 * A scanned page is one image. OCR reads the scanner's original pixels instead of
 * a resampled render: measured on the samples, this read 20 of 20 references
 * correctly, while renders at 2.78x to 5.5x kept misreading "II" as "I". It is
 * also far cheaper for the main thread, so the app stays responsive during OCR.
 */
async function pageImageForOcr(doc: Awaited<ReturnType<typeof openPdf>>, n: number): Promise<Blob> {
  const page = await doc.getPage(n);
  try {
    const { OPS } = await loadPdfjs();
    const ops = await page.getOperatorList();
    const images: string[] = [];
    ops.fnArray.forEach((fn, i) => {
      if (fn === OPS.paintImageXObject) images.push(ops.argsArray[i][0]);
    });
    if (images.length === 1) {
      const img = await new Promise<{ width: number; height: number; bitmap?: CanvasImageSource }>((resolve) => page.objs.get(images[0], resolve));
      if (img.bitmap && img.width > 0 && img.height > 0) {
        const canvas = new OffscreenCanvas(img.width, img.height);
        canvas.getContext('2d')!.drawImage(img.bitmap, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
      }
    }
  } catch {
    /* Fall through to a normal render. */
  }
  const canvas = await renderToCanvas(doc, n, OCR_FALLBACK_SCALE, 0);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read page image'))), 'image/png'));
}

async function ingest(id: number, file: File, target: UploadTarget) {
  try {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      throw new ApiError('Only PDF files can be added.', 415);
    }
    patch(id, { status: 'working', message: 'Reading PDF', progress: 0.02 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    let doc;
    try {
      doc = await openPdf(bytes.slice());
    } catch {
      throw new ApiError('This file could not be opened as a PDF.', 415);
    }
    const pages: string[] = [];
    let usedOcr = false;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = pageTextFromItems(content.items as never);
      if (text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
        usedOcr = true;
        patch(id, { message: `Recognizing text: page ${n} of ${doc.numPages}`, progress: 0.05 + (0.85 * (n - 1)) / doc.numPages });
        const blob = await pageImageForOcr(doc, n);
        const engine = await ocrWorker();
        text = (await engine.recognize(blob)).data.text;
      }
      pages.push(text);
      page.cleanup();
      patch(id, { progress: 0.05 + (0.85 * n) / doc.numPages });
    }
    await doc.loadingTask.destroy();

    patch(id, { message: 'Saving to vault', progress: 0.94 });
    const firstLesson = getState().lessons.length === 0;
    const { lesson, verse_count, unread = [] } = await api.uploadLesson(file, pages, usedOcr ? 'ocr' : 'text', target);
    await refreshAll();
    if (firstLesson) selectLesson(lesson.id);
    const found = verse_count === 1 ? '1 verse' : `${verse_count} verses`;
    patch(id, { status: 'done', progress: 1, verseCount: verse_count, message: `Added "${lesson.title}" with ${found}`, attention: needsAttention(lesson, verse_count, unread), lessonId: lesson.id });
    toast(`Added "${lesson.title}" to ${target === 'pastoral' ? 'Pastoral Visits' : 'the Lesson Library'} (${found}). Check what was read before relying on it.`);
  } catch (e) {
    const message = e instanceof ApiError ? e.message : 'This PDF could not be processed.';
    patch(id, { status: 'error', message, progress: 1 });
    toast(`${file.name}: ${message}`, 'error');
  }
}
