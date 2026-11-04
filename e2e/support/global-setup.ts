import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  const out = join(here, '..', 'coverage-data');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'coverage.json'), JSON.stringify({ clicked: [], seen: {}, unnamed: [] }));
  writeFileSync(join(out, 'perf.json'), JSON.stringify([]));
}
