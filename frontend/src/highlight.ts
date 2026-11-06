import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ocrWorker, pageImageForOcr, releaseWorkerSoon } from './ingest';
import { renderToCanvas } from './pdf';

/** A box on a page, as fractions of its width and height, with the page upright as the PDF sets it. */
export type Box = [x0: number, y0: number, x1: number, y1: number];

interface Word {
  key: string;
  box: Box;
  line: number;
}

/** Same letters, ignoring case, accents and punctuation. */
const normal = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

const MIN_TEXT_CHARS = 30;

/** Words of a page with a text layer, placed by their share of each run of text. */
async function textWords(doc: PDFDocumentProxy, n: number): Promise<Word[] | null> {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items as { str?: string; transform?: number[]; width?: number; height?: number }[];
  if (items.reduce((sum, it) => sum + (it.str?.replace(/\s/g, '').length ?? 0), 0) < MIN_TEXT_CHARS) return null;
  const words: Word[] = [];
  let line = 0;
  let lastY: number | null = null;
  for (const it of items) {
    if (!it.str || !it.transform) continue;
    const [, , c, d, e, f] = it.transform;
    const size = it.height || Math.hypot(c, d) || 10;
    if (lastY !== null && Math.abs(f - lastY) > size * 0.5) line++;
    lastY = f;
    const width = it.width ?? 0;
    const chars = it.str.length || 1;
    for (const m of it.str.matchAll(/\S+/g)) {
      const key = normal(m[0]);
      if (!key) continue;
      const x0 = e + (width * m.index) / chars;
      const x1 = e + (width * (m.index + m[0].length)) / chars;
      const [a0, b0] = viewport.convertToViewportPoint(x0, f - size * 0.25) as number[];
      const [a1, b1] = viewport.convertToViewportPoint(x1, f + size * 0.9) as number[];
      words.push({
        key,
        line,
        box: [Math.min(a0, a1) / viewport.width, Math.min(b0, b1) / viewport.height, Math.max(a0, a1) / viewport.width, Math.max(b0, b1) / viewport.height],
      });
    }
  }
  return words;
}

/** Words of a scanned page, read by the same OCR as at upload. */
async function scannedWords(doc: PDFDocumentProxy, n: number): Promise<Word[]> {
  const page = await doc.getPage(n);
  // A scan's own pixels cover the page as it is stored; a turned page is read from a render instead.
  const image = page.rotate === 0 ? await pageImageForOcr(doc, n) : await new Promise<Blob>((resolve, reject) => {
    renderToCanvas(doc, n, 3, 0).then((c) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('No page image'))), 'image/png'), reject);
  });
  const bitmap = await createImageBitmap(image);
  const w = bitmap.width;
  const h = bitmap.height;
  bitmap.close();
  const engine = await ocrWorker();
  try {
    const { data } = await engine.recognize(image, {}, { text: false, blocks: true });
    const words: Word[] = [];
    let line = 0;
    for (const block of data.blocks ?? [])
      for (const para of block.paragraphs)
        for (const l of para.lines) {
          line++;
          for (const word of l.words) {
            const key = normal(word.text);
            if (key) words.push({ key, line, box: [word.bbox.x0 / w, word.bbox.y0 / h, word.bbox.x1 / w, word.bbox.y1 / h] });
          }
        }
    return words;
  } finally {
    releaseWorkerSoon();
  }
}

// Pages already read, in memory only: lesson text is sensitive and is never stored by the browser.
const MAX_PAGES = 12;
const pages = new Map<string, Promise<Word[]>>();

function pageWords(doc: PDFDocumentProxy, key: string, n: number) {
  let words = pages.get(key);
  if (!words) {
    words = textWords(doc, n).then((w) => w ?? scannedWords(doc, n));
    pages.set(key, words);
    words.catch(() => pages.delete(key));
    while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value as string);
  }
  return words;
}

/** Nearly the same word: a scan often misreads a letter or two. */
function close(a: string, b: string) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return a.length - i - j <= 1 && b.length - i - j <= 1;
}

/**
 * Where the verse is printed on the page: the run of page words that best lines up with
 * the verse's words, allowing for words the scan misread, dropped or ran together.
 */
export function bestRun(verse: string[], words: string[]): { start: number; end: number; matched: number } | null {
  const n = verse.length;
  const m = words.length;
  if (!n || !m) return null;
  // Local alignment, keeping one row at a time. Each cell remembers where its run began.
  let prev = new Float64Array(m + 1);
  let prevStart = new Int32Array(m + 1);
  let prevHits = new Int32Array(m + 1);
  let best = { score: 0, start: 0, end: -1, matched: 0 };
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1);
    const curStart = new Int32Array(m + 1);
    const curHits = new Int32Array(m + 1);
    for (let j = 1; j <= m; j++) {
      const same = verse[i - 1] === words[j - 1] ? 3 : close(verse[i - 1], words[j - 1]) ? 2 : -2;
      const options: [number, number, number][] = [
        [prev[j - 1] + same, prev[j - 1] > 0 ? prevStart[j - 1] : j - 1, (prev[j - 1] > 0 ? prevHits[j - 1] : 0) + (same > 0 ? 1 : 0)],
        [prev[j] - 1, prevStart[j], prevHits[j]],
        [cur[j - 1] - 1, curStart[j - 1], curHits[j - 1]],
      ];
      let pick: [number, number, number] = [0, j, 0];
      for (const o of options) if (o[0] > pick[0]) pick = o;
      cur[j] = pick[0];
      curStart[j] = pick[1];
      curHits[j] = pick[2];
      if (pick[0] > best.score) best = { score: pick[0], start: pick[1], end: j - 1, matched: pick[2] };
    }
    prev = cur;
    prevStart = curStart;
    prevHits = curHits;
  }
  // Enough of the verse must be there, or nothing is shown rather than the wrong lines.
  if (best.end < best.start || best.matched < Math.min(n, Math.max(3, Math.ceil(n * 0.45)))) return null;
  return { start: best.start, end: best.end, matched: best.matched };
}

/** One box for each printed line the verse covers. */
function lineBoxes(words: Word[]): Box[] {
  const boxes = new Map<number, Box>();
  for (const w of words) {
    const b = boxes.get(w.line);
    boxes.set(w.line, b ? [Math.min(b[0], w.box[0]), Math.min(b[1], w.box[1]), Math.max(b[2], w.box[2]), Math.max(b[3], w.box[3])] : [...w.box]);
  }
  return [...boxes.values()].sort((a, b) => a[1] - b[1]);
}

/** Where a verse was found: the first page it is on, and its lines on each page. */
export interface Found {
  page: number;
  boxes: Record<number, Box[]>;
}

/**
 * Finds a verse's text on the page its reference was read from. A verse printed at the
 * foot of a page often runs on to the next one, so that page is read as well when the
 * verse is not all there. Null when it cannot be found.
 */
export async function findVerse(doc: PDFDocumentProxy, url: string, pageNumber: number, text: string): Promise<Found | null> {
  const verse = text.split(/\s+/).map(normal).filter(Boolean);
  if (verse.length === 0) return null;
  let words = (await pageWords(doc, `${url}|${pageNumber}`, pageNumber)).map((w) => ({ ...w, page: pageNumber }));
  let run = bestRun(verse, words.map((w) => w.key));
  const runsOn = !run || (run.end >= words.length - 3 && run.matched < verse.length * 0.9);
  if (runsOn && pageNumber < doc.numPages) {
    const next = pageNumber + 1;
    const both = [...words, ...(await pageWords(doc, `${url}|${next}`, next)).map((w) => ({ ...w, page: next }))];
    const wider = bestRun(verse, both.map((w) => w.key));
    if (wider && (!run || wider.matched > run.matched)) {
      run = wider;
      words = both;
    }
  }
  if (!run) return null;
  const marked = words.slice(run.start, run.end + 1);
  const boxes: Record<number, Box[]> = {};
  for (const p of new Set(marked.map((w) => w.page))) boxes[p] = lineBoxes(marked.filter((w) => w.page === p));
  return { page: marked[0].page, boxes };
}

/** A box as it shows on a page turned by the viewer, clockwise in steps of 90 degrees. */
export function turned([x0, y0, x1, y1]: Box, rotation: number): Box {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [1 - y1, x0, 1 - y0, x1];
    case 180:
      return [1 - x1, 1 - y1, 1 - x0, 1 - y0];
    case 270:
      return [y0, 1 - x1, y1, 1 - x0];
    default:
      return [x0, y0, x1, y1];
  }
}
