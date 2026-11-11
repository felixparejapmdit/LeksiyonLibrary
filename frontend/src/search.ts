import aliasVocabulary from '../../shared/search-aliases.json' with { type: 'json' };

/** Offline keyword aliases, shared with Rust. This is not machine translation. */
const MAX_QUERY_CHARS = 512;
const MAX_QUERY_WORDS = 24;
const MAX_QUERY_GROUPS = 16;

export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    // OCR can attach a verse number to the first word, or a chapter to its book.
    .replace(/(^|[^\p{L}\p{N}])([0-9]{1,3})(\p{L})/gu, '$1$2 $3')
    .replace(/(\p{L})([0-9]+)($|[^\p{L}\p{N}])/gu, '$1 $2$3')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const aliases = new Map<string, readonly string[]>();
let longestAlias = 1;
for (const vocabulary of aliasVocabulary) {
  const group = [...new Set(vocabulary.map(normalizeSearch).filter(Boolean))];
  for (const word of group) {
    aliases.set(word, group);
    longestAlias = Math.max(longestAlias, word.split(' ').length);
  }
}

/** Normalized literal query words, suitable for a compact query summary. */
export function searchTerms(query: string): string[] {
  return normalizeSearch(query.slice(0, MAX_QUERY_CHARS)).split(' ').filter(Boolean).slice(0, MAX_QUERY_WORDS);
}

interface Group {
  alternatives: readonly string[];
  prefix: boolean;
}

// Queries stay in memory only. Bounding the cache prevents a long session growing it.
const plans = new Map<string, readonly Group[]>();
function searchPlan(query: string): readonly Group[] {
  const key = query.slice(0, MAX_QUERY_CHARS);
  const saved = plans.get(key);
  if (saved) return saved;
  const words = searchTerms(key);
  const groups: Group[] = [];
  for (let at = 0; at < words.length && groups.length < MAX_QUERY_GROUPS;) {
    let matched = false;
    for (let length = Math.min(longestAlias, words.length - at); length > 0; length--) {
      const alternatives = aliases.get(words.slice(at, at + length).join(' '));
      if (!alternatives) continue;
      groups.push({ alternatives, prefix: false });
      at += length;
      matched = true;
      break;
    }
    if (!matched) {
      const word = words[at++];
      // Complete concept/book names match whole words. Only an unfinished final
      // literal word gets type-ahead matching, so "faith" does not match "faithful".
      groups.push({ alternatives: [word], prefix: at === words.length && /^\p{L}{3,}$/u.test(word) });
    }
  }
  // Keep chapter and verse together; Genesis 6:8 must not match Genesis 8:6.
  for (const reference of key.matchAll(/\b\d{1,3}\s*:\s*\d{1,3}(?:\s*[-–]\s*\d{1,3})?/gu)) {
    if (groups.length >= MAX_QUERY_GROUPS) break;
    groups.push({ alternatives: [normalizeSearch(reference[0])], prefix: false });
  }
  if (plans.size >= 32) plans.delete(plans.keys().next().value!);
  plans.set(key, groups);
  return groups;
}

/** AND between query groups; OR between the known spellings/translations in each. */
export function searchGroups(query: string): string[][] {
  return searchPlan(query).map((group) => [...group.alternatives]);
}

export function matchesSearch(text: string, query: string): boolean {
  if (!query.trim()) return true;
  const groups = searchPlan(query);
  if (!groups.length) return false;
  const normalized = normalizeSearch(text);
  const padded = ` ${normalized} `;
  const words = normalized.split(' ');
  return groups.every((group) => group.alternatives.some((alternative) =>
    padded.includes(` ${alternative} `) || (group.prefix && words.some((word) => word.startsWith(alternative))),
  ));
}
