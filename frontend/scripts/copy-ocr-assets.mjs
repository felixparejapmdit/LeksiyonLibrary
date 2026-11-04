// Copies the OCR engine, language models and PDF support files into public/ so
// the app works offline and never fetches from a CDN at runtime.
import { cpSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const nm = join(process.cwd(), 'node_modules');
if (!existsSync(join(nm, 'tesseract.js'))) process.exit(0);

const ocr = join(process.cwd(), 'public', 'ocr');
mkdirSync(ocr, { recursive: true });
cpSync(join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(ocr, 'worker.min.js'));
for (const f of readdirSync(join(nm, 'tesseract.js-core'))) {
  if (/lstm\.wasm\.js$/.test(f)) cpSync(join(nm, 'tesseract.js-core', f), join(ocr, f));
}
for (const lang of ['eng', 'tgl']) {
  cpSync(join(nm, '@tesseract.js-data', lang, '4.0.0', `${lang}.traineddata.gz`), join(ocr, `${lang}.traineddata.gz`));
}

const pdf = join(process.cwd(), 'public', 'pdfjs');
for (const dir of ['standard_fonts', 'wasm', 'cmaps']) {
  const from = join(nm, 'pdfjs-dist', dir);
  if (existsSync(from)) cpSync(from, join(pdf, dir), { recursive: true });
}
console.log('OCR and PDF assets copied to public/');
