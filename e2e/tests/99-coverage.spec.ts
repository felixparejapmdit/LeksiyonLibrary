import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { coverageFile, perfFile } from '../support/fixtures';

const isYear = (id: string) => /^year-(expand-)?\d+$/.test(id);

test('every visible button and link was actually clicked by a test', () => {
  const { clicked, seen, unnamed } = JSON.parse(readFileSync(coverageFile, 'utf8'));
  const all = Object.keys(seen).filter((id) => !isYear(id));
  expect(unnamed, 'interactive elements without a test id or accessible name').toEqual([]);
  const missed = all.filter((id) => !clicked.includes(id));
  console.log(`Controls seen: ${Object.keys(seen).length}. Controls clicked: ${clicked.length}.`);
  expect(missed, 'controls no test ever clicked').toEqual([]);
  expect(Object.keys(seen).filter(isYear).some((id) => clicked.includes(id))).toBe(true);
});

test('performance summary', () => {
  const rows = JSON.parse(readFileSync(perfFile, 'utf8'));
  console.table(rows);
  expect(rows.length).toBeGreaterThan(5);
});
