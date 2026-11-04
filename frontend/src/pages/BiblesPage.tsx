import { memo, useMemo, useState } from 'react';
import { BadgeCheck, Check, Copy, FileSearch, ListChecks, Lock, Loader2, PencilLine, Search, ShieldAlert, Sparkles, X } from 'lucide-react';
import { api, type Verse } from '../api';
import { VerseCorrectionDialog } from '../components/Overlays';
import { Highlight } from '../components/LessonList';
import { useProgressive } from '../components/Layout';
import { askConfirm, errorText, getState, navigate, resetFilters, selectLesson, setState, toast, useStore, verseGroups } from '../store';

function replaceVerse(v: Verse) {
  setState({ verses: getState().verses.map((x) => (x.id === v.id ? v : x)) });
}

export async function copyVerse(v: Verse) {
  const text = `${v.ref_printed}${v.version ? ` (${v.version})` : ''}\n${v.text}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Verse copied');
  } catch {
    toast('Your browser blocked copying. Select the text instead.', 'error');
  }
}

const VerseCard = memo(function VerseCard({ verse, query }: { verse: Verse; query: string }) {
  const [correcting, setCorrecting] = useState(false);
  const verified = verse.status === 'verified';
  const source = verse.sources[0];
  return (
    <div className="flex h-full flex-col rounded-lg border border-line bg-panel p-3" data-testid="verse-card" data-verse-id={verse.id} data-language={verse.language} data-status={verse.status}>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded border border-line px-1 font-semibold">{verse.language === 'tl' ? 'Tagalog' : 'English'}</span>
        {verse.version && <span className="rounded border border-line px-1 text-muted" data-testid="verse-version">{verse.version}</span>}
        <span className="font-medium" data-testid="verse-ref">{verse.ref_printed}</span>
        {verified ? (
          <span className="flex items-center gap-1 text-ok" data-testid="verse-verified"><Lock size={12} /> Verified, locked</span>
        ) : (
          <span className="flex items-center gap-1 text-warn" data-testid="verse-unverified"><ShieldAlert size={12} /> Unverified scan</span>
        )}
      </div>
      {verse.ref_note && !verified && <p className="m-0 mb-1.5 text-xs text-warn" data-testid="verse-ref-note">{verse.ref_note}</p>}
      <p className="m-0 flex-1 text-[14px] leading-relaxed whitespace-pre-wrap" data-testid="verse-text">
        {verse.text ? <Highlight text={verse.text} query={query} /> : <span className="text-muted">Reference only. No text was printed in this lesson.</span>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="verse-copy" disabled={!verse.text} onClick={() => copyVerse(verse)}>
          <Copy size={13} /> Copy
        </button>
        {source && (
          <button
            className="btn !min-h-8 max-lg:!min-h-11"
            data-testid="verse-source"
            onClick={() => {
              resetFilters();
              selectLesson(source.lesson_id, source.page);
              setState({ viewerOpen: true });
              navigate('/');
            }}
          >
            <FileSearch size={13} /> Source p.{source.page}
          </button>
        )}
        {!verified && (
          <>
            <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="verse-correct" onClick={() => setCorrecting(true)}>
              <PencilLine size={13} /> Correct
            </button>
            <button
              className="btn !min-h-8 max-lg:!min-h-11"
              data-testid="verse-verify"
              disabled={!verse.text}
              onClick={() =>
                askConfirm({
                  title: 'Mark this verse as verified?',
                  body: `Confirm that the reference ${verse.ref_printed} and its text match the printed page exactly. Once verified it can never be edited, by you or by the AI.`,
                  confirmLabel: 'Verify and lock',
                  onConfirm: async () => {
                    replaceVerse(await api.verifyVerse(verse.id));
                    toast('Verse verified and locked');
                  },
                })
              }
            >
              <Check size={13} /> Verify
            </button>
          </>
        )}
      </div>
      {correcting && (
        <VerseCorrectionDialog
          text={verse.text}
          raw={verse.ocr_raw}
          reference={verse.ref_printed}
          onClose={() => setCorrecting(false)}
          onSave={async (patch) => {
            replaceVerse(await api.correctVerse(verse.id, patch));
            setCorrecting(false);
            toast('Correction saved');
          }}
        />
      )}
    </div>
  );
});

export function BiblesPage() {
  const verses = useStore((s) => s.verses);
  const [query, setLocalQuery] = useState('');
  const [language, setLanguage] = useState<'all' | 'en' | 'tl'>('all');
  const [status, setStatus] = useState<'all' | 'verified' | 'unverified'>('all');
  const [meaningKeys, setMeaningKeys] = useState<string[] | null>(null);
  const [meaningBusy, setMeaningBusy] = useState(false);

  const findByMeaning = async () => {
    setMeaningBusy(true);
    try {
      const res = await api.searchMeaning(query);
      if (res.available) setMeaningKeys(res.keys);
      else toast('Search by meaning needs the local AI model. Searching by words still works.', 'error');
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setMeaningBusy(false);
  };

  const stats = useMemo(() => ({ verified: verses.filter((v) => v.status === 'verified').length, total: verses.length }), [verses]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = verses.filter((v) => {
      if (language !== 'all' && v.language !== language) return false;
      if (status !== 'all' && v.status !== status) return false;
      if (meaningKeys) return meaningKeys.includes(v.canonical_key);
      if (q && !`${v.ref_en} ${v.ref_tl} ${v.ref_printed} ${v.version} ${v.text}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (meaningKeys) return verseGroups(filtered).sort((a, b) => meaningKeys.indexOf(a.key) - meaningKeys.indexOf(b.key));
    return verseGroups(filtered).sort((a, b) => a.book - b.book || a.items[0].ref_en.localeCompare(b.items[0].ref_en, undefined, { numeric: true }));
  }, [verses, query, language, status, meaningKeys]);

  const shownGroups = useProgressive(groups, 30);

  return (
    <div className="scroll-stable h-full" data-testid="bibles-page">
      <div className="mx-auto max-w-6xl p-3 lg:p-4">
        <h1 className="m-0 text-lg font-semibold">Bibles Library</h1>
        <p className="m-0 mt-0.5 mb-3 flex items-start gap-1.5 text-[13px] text-muted" data-testid="bibles-policy">
          <BadgeCheck size={15} className="mt-0.5 flex-none text-ok" />
          Verses are collected from your lessons exactly as scanned. Verified text is locked permanently, and the AI can never change it. {stats.verified} of {stats.total} verified.
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
            <input className="field !pl-9" placeholder="Search references or wording" aria-label="Search verses" data-testid="bibles-search" value={query} onChange={(e) => { setLocalQuery(e.target.value); setMeaningKeys(null); }} />
          </div>
          <button className="btn" data-testid="bibles-meaning" disabled={!query.trim() || meaningBusy} onClick={findByMeaning}>
            {meaningBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Find by meaning
          </button>
          <select className="field !w-auto" aria-label="Filter by language" data-testid="bibles-language" value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
            <option value="all">All languages</option>
            <option value="tl">Tagalog</option>
            <option value="en">English</option>
          </select>
          <select className="field !w-auto" aria-label="Filter by status" data-testid="bibles-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">All statuses</option>
            <option value="unverified">Unverified</option>
            <option value="verified">Verified</option>
          </select>
          <button className="btn" data-testid="bibles-review" onClick={() => navigate('/review')}>
            <ListChecks size={14} /> Review verses
          </button>
        </div>
        {meaningKeys && (
          <p className="m-0 mb-3 flex items-center gap-2 text-[13px] text-muted" data-testid="bibles-meaning-note">
            Verses related in meaning to "{query}", closest first. These are suggestions from the local AI.
            <button className="icon-btn" aria-label="Clear search by meaning" data-testid="bibles-meaning-clear" onClick={() => setMeaningKeys(null)}><X size={14} /></button>
          </p>
        )}
        {groups.length === 0 ? (
          <p className="py-14 text-center text-[13px] text-muted" data-testid="bibles-empty">
            {verses.length === 0 ? 'No verses yet. Upload a lesson and its verses will be collected here.' : meaningKeys ? 'No verses are close in meaning.' : 'No verses match these filters.'}
          </p>
        ) : (
          <ul className="m-0 list-none space-y-4 p-0" data-testid="bibles-groups">
            {shownGroups.map((g) => (
              <li key={g.key} className="card-cv" data-testid="verse-group" data-key={g.key}>
                <h2 className="m-0 mb-1.5 text-[14px] font-semibold" data-testid="verse-group-title">
                  {g.items[0].ref_en}
                  {g.items[0].ref_tl !== g.items[0].ref_en && <span className="font-normal text-muted"> · {g.items[0].ref_tl}</span>}
                </h2>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {g.items.map((v) => (
                    <VerseCard key={v.id} verse={v} query={query} />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export { errorText };
