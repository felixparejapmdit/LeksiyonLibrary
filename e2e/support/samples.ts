// The real sample lessons are sensitive, so neither they nor any text from them are kept
// in this repository. LV_SAMPLES points to a private folder holding samples.json, which
// lists the sample PDFs and what each test should expect to read from them.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.env.LV_SAMPLES ?? join(here, '..', '..', '..', 'LeksiyonLibrary-private');
export const samples = JSON.parse(readFileSync(join(dir, 'samples.json'), 'utf8'));
