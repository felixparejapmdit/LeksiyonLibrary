// Prints failures and performance numbers from the last run.
const fs = require('fs');
const r = JSON.parse(fs.readFileSync('test-results/results.json', 'utf8'));
const clean = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const walk = (s) => {
  for (const c of s.suites || []) walk(c);
  for (const sp of s.specs || [])
    for (const t of sp.tests)
      for (const res of t.results)
        if (res.status !== 'passed') {
          console.log(`\n## ${sp.file}: ${sp.title} [${res.status}]`);
          for (const e of (res.errors || []).slice(0, 3)) console.log(clean(e.message).split('\n').filter(Boolean).slice(0, 12).join(' | ').slice(0, 900));
        }
};
walk(r);
console.log('\nstats', JSON.stringify(r.stats));
console.table(JSON.parse(fs.readFileSync('coverage-data/perf.json', 'utf8')));
const cov = JSON.parse(fs.readFileSync('coverage-data/coverage.json', 'utf8'));
console.log('seen', Object.keys(cov.seen).length, 'clicked', cov.clicked.length);
console.log('missed', Object.keys(cov.seen).filter((k) => !cov.clicked.includes(k) && !/^year-/.test(k)));
