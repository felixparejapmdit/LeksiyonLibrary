import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, FileDown, FilePlus2, Loader2, Lock, MonitorPlay, PencilLine, Plus, Printer, Save, Sparkles, Trash2, X } from 'lucide-react';
import { PresentationMode } from '../components/Presentation';
import { backgroundAsText, backgroundOf, ContextLines } from '../components/VerseContext';
import { api, saveFile, type Lecture, type Suggestion, type Verse } from '../api';
import { askConfirm, errorText, getState, refreshAll, setState, toast, useStore } from '../store';

type NotesStatus = 'idle' | 'loading' | 'ready' | 'offline';
type Group = { title: string | null; objective: string; logId: string; suggestions: Suggestion[]; status: NotesStatus; notes: Record<string, string> };
type Coverage = 'best' | '3' | '4' | '5';

const objectiveLines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

function ReadOnlyVerse({ verse }: { verse: Verse }) {
  const lessons = useStore((s) => s.lessons);
  const source = verse.sources[0];
  const lesson = source && lessons.find((l) => l.id === source.lesson_id);
  return (
    <div className="rounded-md border border-line p-2" data-testid="suggested-verse" data-verse-id={verse.id}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Lock size={11} />
        <span className="font-semibold text-fg">{verse.language === 'tl' ? 'Tagalog' : 'English'}</span>
        {verse.version && <span>{verse.version}</span>}
        <span data-testid="suggested-status">{verse.status === 'verified' ? 'Verified' : 'Unverified scan'}</span>
      </div>
      <p className="m-0 text-[13px] leading-relaxed" data-testid="suggested-text">{verse.text || 'Reference only.'}</p>
      {lesson && <p className="m-0 mt-1 text-xs text-muted" data-testid="verse-source">Cited in {lesson.title}, page {source.page}</p>}
    </div>
  );
}

export function LecturePage() {
  const verses = useStore((s) => s.verses);
  const lectures = useStore((s) => s.lectures);
  const byId = useMemo(() => new Map(verses.map((v) => [v.id, v])), [verses]);
  const [lectureId, setLectureId] = useState<string | undefined>();
  const [title, setTitle] = useState('');
  const [issue, setIssue] = useState('');
  const [objective, setObjective] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  // The objective each picked verse was chosen for, kept when a lecture is saved.
  const [objectiveOf, setObjectiveOf] = useState<Record<string, string>>({});
  const [presenting, setPresenting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [coverage, setCoverage] = useState<Coverage>('3');
  const [groups, setGroups] = useState<Group[] | null>(null);
  const contexts = useStore((s) => s.contexts);
  const scripture = useStore((s) => s.scripture);
  const lessons = useStore((s) => s.lessons);
  const [sourceLesson, setSourceLesson] = useState('');
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestSeq = useRef(0);
  const [aiState, setAiState] = useState<{ available: boolean; model: string; meaning: boolean } | null>(null);
  const [usedMeaning, setUsedMeaning] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    api.aiStatus().then((s) => alive && setAiState(s)).catch(() => alive && setAiState({ available: false, model: '', meaning: false }));
    return () => {
      alive = false;
    };
  }, []);

  const suggest = async (e: React.FormEvent) => {
    e.preventDefault();
    const seq = ++requestSeq.current;
    setSearching(true);
    const patchGroup = (i: number, p: Partial<Group>) => setGroups((g) => g && g.map((x, n) => (n === i ? { ...x, ...p } : x)));
    try {
      const lines = objectiveLines(objective);
      const wanted: { title: string | null; objective: string; count?: number }[] =
        coverage === 'best'
          ? [{ title: null, objective }]
          : lines.length > 0
            ? lines.map((l) => ({ title: l, objective: l, count: Number(coverage) }))
            : [{ title: issue.trim(), objective: '', count: Number(coverage) }];
      // Matches appear right away; AI notes fill in afterwards without moving anything.
      const found = await Promise.all(wanted.map((w) => api.aiSuggest(issue, w.objective, w.count)));
      if (seq !== requestSeq.current) return;
      const next: Group[] = wanted.map((w, i) => ({
        title: w.title,
        objective: w.objective,
        logId: found[i].log_id,
        suggestions: found[i].suggestions,
        status: found[i].suggestions.length ? 'loading' : 'idle',
        notes: {},
      }));
      setGroups(next);
      setUsedMeaning(found.some((f) => f.meaning));
      setSearching(false);
      // One objective at a time: the local model can only do one well on a CPU.
      for (let i = 0; i < next.length; i++) {
        if (next[i].suggestions.length === 0) continue;
        const n = await api.aiNotes(next[i].logId);
        if (seq !== requestSeq.current) return;
        if (!n.available) {
          // No point waiting for the same failure once per objective.
          setGroups((g) => g && g.map((x) => (x.status === 'loading' ? { ...x, status: 'offline' } : x)));
          return;
        }
        patchGroup(i, { status: 'ready', notes: n.notes });
        setState({ contexts: n.context, scripture: n.scripture });
        const model = n.model;
        if (model) setAiState((a) => ({ available: true, model, meaning: a?.meaning ?? false }));
      }
    } catch (err) {
      if (seq === requestSeq.current) {
        setSearching(false);
        setGroups((g) => g && g.map((x) => (x.status === 'loading' ? { ...x, status: 'offline' } : x)));
        toast(errorText(err), 'error');
      }
    }
  };

  const newLecture = () => {
    setLectureId(undefined);
    setTitle('');
    setIssue('');
    setObjective('');
    setPicked([]);
    setObjectiveOf({});
    setGroups(null);
    setSourceLesson('');
  };

  const load = (l: Lecture) => {
    setLectureId(l.id);
    setTitle(l.title);
    setIssue(l.issue);
    setObjective(l.objective);
    setPicked(l.verse_ids);
    setObjectiveOf(Object.fromEntries(l.verse_ids.map((id, i) => [id, l.verse_objectives[i] ?? ''])));
    setGroups(null);
    setSourceLesson('');
  };

  const startFromLesson = (id: string) => {
    setSourceLesson(id);
    const lesson = lessons.find((l) => l.id === id);
    if (!lesson) return;
    setIssue(lesson.issue);
    setObjective(lesson.objectives.join('\n'));
    setGroups(null);
  };

  const move = (i: number, d: number) =>
    setPicked((p) => {
      const n = [...p];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });

  const objectiveFor = (id: string) => objectiveOf[id] ?? '';
  const lectureBody = () => ({ title, issue, objective, verse_ids: picked, verse_objectives: picked.map(objectiveFor) });
  const slides = picked.flatMap((id) => {
    const verse = byId.get(id);
    return verse ? [{ verse, objective: objectiveFor(id) }] : [];
  });

  const asText = () => {
    const grouped = picked.some((id) => objectiveFor(id));
    return [
      title,
      ...(issue ? [`Issue: ${issue}`] : []),
      ...(objective && !grouped ? [`Objective: ${objective}`] : []),
      '',
      ...picked.flatMap((id, i) => {
        const v = byId.get(id);
        if (!v) return [];
        const heading = objectiveFor(id) && objectiveFor(id) !== objectiveFor(picked[i - 1]) ? [objectiveFor(id), ''] : [];
        return [
          ...heading,
          `${v.ref_printed}${v.version ? ` (${v.version})` : ''}`,
          v.text,
          ...backgroundAsText(backgroundOf({ contexts, scripture }, v.canonical_key)),
          '',
        ];
      }),
    ].join('\n');
  };

  const contextButton = (key: string, testId: string) => {
    const c = backgroundOf({ contexts, scripture }, key);
    return (
      <button className="btn no-print !min-h-7 max-lg:!min-h-11" data-testid={testId} onClick={() => setState({ editingContextKey: key })}>
        <PencilLine size={12} /> {c.empty ? 'Add speaker and context' : c.reviewed ? 'Edit context' : 'Review or correct'}
      </button>
    );
  };

  return (
    <div className="scroll-stable h-full" data-testid="lecture-page">
      {presenting && <PresentationMode title={title || 'Lecture'} slides={slides} onClose={() => setPresenting(false)} />}
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 p-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:p-4">
        <div className="min-w-0 space-y-3">
          <div className="no-print">
            <h1 className="m-0 text-lg font-semibold">Lecture Maker</h1>
            <p className="m-0 mt-0.5 text-[13px] text-muted">Describe the issue and objective. Suggestions come only from verses already in your library, shown exactly as stored.</p>
          </div>
          <form className="no-print space-y-2 rounded-lg border border-line bg-panel p-3" onSubmit={suggest}>
            <label className="block text-xs text-muted">
              Start from a lesson
              <select className="field mt-1" data-testid="lecture-from-lesson" value={sourceLesson} onChange={(e) => startFromLesson(e.target.value)}>
                <option value="">Choose a lesson to load its issue and objectives</option>
                {lessons.filter((l) => l.issue || l.objectives.length > 0).map((l) => (
                  <option key={l.id} value={l.id}>{l.language === 'tl' ? 'TL' : 'EN'}: {l.title}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-muted">
              Issue or topic
              <textarea className="field mt-1 min-h-16" data-testid="lecture-issue" placeholder="What situation should this lecture address?" value={issue} onChange={(e) => setIssue(e.target.value)} />
            </label>
            <label className="block text-xs text-muted">
              Objectives (one per line)
              <textarea className="field mt-1 min-h-16" data-testid="lecture-objective" placeholder="What should listeners understand or do?" value={objective} onChange={(e) => setObjective(e.target.value)} />
            </label>
            <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
              Verses to present
              <select className="field !min-h-[34px] !w-auto !py-1 !text-xs max-lg:!min-h-11" data-testid="lecture-coverage" value={coverage} onChange={(e) => setCoverage(e.target.value as Coverage)}>
                <option value="3">3 per objective</option>
                <option value="4">4 per objective</option>
                <option value="5">5 per objective</option>
                <option value="best">Best matches overall</option>
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" data-testid="lecture-suggest" disabled={searching || (!issue.trim() && !objective.trim())}>
                <Sparkles size={14} /> Suggest verses
              </button>
              <span className="text-xs text-muted" data-testid="ai-status">
                {aiState === null ? 'Checking AI' : aiState.available ? `AI notes by ${aiState.model}` : 'AI notes offline. Verse matching still works.'}
              </span>
              {searching && <span className="flex items-center gap-1 text-xs text-muted" data-testid="lecture-searching"><Loader2 size={12} className="animate-spin" /> Searching</span>}
            </div>
          </form>

          {groups !== null && (
            <section className="no-print space-y-2" aria-label="Suggestions" data-testid="suggestions">
              <div className="flex items-center gap-2 text-xs text-muted">
                <h2 className="m-0 text-[13px] font-semibold text-fg">Suggestions ({groups.reduce((n, g) => n + g.suggestions.length, 0)})</h2>
                {groups.some((g) => g.status === 'loading') && <span className="flex items-center gap-1" data-testid="notes-loading"><Loader2 size={12} className="animate-spin" /> Writing AI notes and chapter and book context. This can take a few minutes the first time; keep working.</span>}
                {groups.some((g) => g.status === 'offline') && <span data-testid="notes-offline">AI notes and context unavailable</span>}
              </div>
              <p className="m-0 text-xs text-muted" data-testid="match-mode">{usedMeaning ? 'Matched by meaning and words' : 'Matched by words only'}</p>
              {groups.every((g) => g.suggestions.length === 0) && <p className="m-0 rounded-lg border border-line p-4 text-center text-[13px] text-muted" data-testid="suggestions-empty">No verses in your library match. Try other words, or upload more lessons.</p>}
              {groups.some((g) => g.suggestions.length > 0) && groups.map((g, groupIndex) => (
              <div key={groupIndex} className="space-y-2" data-testid="objective-group">
                {g.title !== null && (
                  <div className="mt-3 first:mt-0">
                    <h3 className="m-0 text-[13px] font-semibold text-accent2" data-testid="objective-title">{g.title}</h3>
                    {coverage !== 'best' && g.suggestions.length < Number(coverage) && (
                      <p className="m-0 text-xs text-muted" data-testid="objective-shortfall">
                        {g.suggestions.length === 0 ? 'No verses in your library match this objective.' : `Only ${g.suggestions.length} of ${coverage} found in your library.`}
                      </p>
                    )}
                  </div>
                )}
              {g.suggestions.map((s) => {
                const items = s.verse_ids.map((id) => byId.get(id)).filter((v): v is Verse => !!v);
                return (
                  <article key={s.canonical_key} className="rounded-lg border border-line bg-panel p-3" data-testid="suggestion" data-key={s.canonical_key}>
                    <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                      <h3 className="m-0 text-[14px] font-semibold" data-testid="suggestion-ref">{s.ref_en}</h3>
                      {s.ref_tl !== s.ref_en && <span className="text-xs text-muted">{s.ref_tl}</span>}
                      {s.matched_terms.length > 0 && <span className="text-xs text-muted">Matches: {s.matched_terms.join(', ')}</span>}
                      {s.meaning && <span className="text-xs text-muted" data-testid="suggestion-meaning">Related in meaning</span>}
                    </div>
                    {/* Space is reserved so the note and context appearing do not shift the page. */}
                    <p className="m-0 mb-1 min-h-5 text-xs text-accent2" data-testid="ai-note">
                      {g.notes[s.canonical_key] && (
                        <>
                          <span className="font-semibold">AI note, not scripture. Review before use: </span>
                          {g.notes[s.canonical_key]}
                        </>
                      )}
                    </p>
                    <p className="m-0 mb-1 min-h-28 text-xs leading-relaxed text-accent2" data-testid="ai-context">
                      <ContextLines verseKey={s.canonical_key} reference={s.ref_en} testId="verse-context" />
                    </p>
                    <div className="mb-2">{contextButton(s.canonical_key, 'context-edit')}</div>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      {items.map((v) => (
                        <div key={v.id} className="flex flex-col gap-1">
                          <ReadOnlyVerse verse={v} />
                          <button
                            className="btn !min-h-8 self-start max-lg:!min-h-11"
                            data-testid="suggestion-add"
                            disabled={picked.includes(v.id)}
                            onClick={() => {
                              setPicked((p) => [...p, v.id]);
                              setObjectiveOf((o) => ({ ...o, [v.id]: g.title ?? '' }));
                            }}
                          >
                            <Plus size={13} /> {picked.includes(v.id) ? 'Added' : 'Add to lecture'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </article>
                );
              })}
              </div>
              ))}
            </section>
          )}
        </div>

        <div className="min-w-0 space-y-3 lg:sticky lg:top-4 lg:self-start">
          <section className="rounded-lg border border-line bg-panel p-3" aria-label="Lecture workspace" data-testid="workspace">
            <div className="no-print mb-2 flex items-center justify-between gap-2">
              <h2 className="m-0 text-[14px] font-semibold">Workspace</h2>
              <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="lecture-new" onClick={newLecture}>
                <FilePlus2 size={13} /> New
              </button>
            </div>
            <label className="block text-xs text-muted">
              Lecture title
              <input className="field mt-1" data-testid="lecture-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            {picked.length === 0 ? (
              <p className="mt-3 mb-1 text-center text-[13px] text-muted" data-testid="workspace-empty">Added verses appear here.</p>
            ) : (
              <ol className="m-0 mt-3 list-none space-y-2 p-0" data-testid="workspace-list">
                {picked.map((id, i) => {
                  const v = byId.get(id);
                  if (!v) return null;
                  return (
                    <li key={id}>
                      {objectiveFor(id) && objectiveFor(id) !== objectiveFor(picked[i - 1]) && <h3 className="m-0 mb-1 text-[13px] font-semibold text-accent2" data-testid="workspace-objective">{objectiveFor(id)}</h3>}
                      <div className="rounded-md border border-line p-2" data-testid="workspace-verse" data-verse-id={id}>
                      <div className="flex items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{v.ref_printed}{v.version ? ` (${v.version})` : ''}</span>
                        <span className="no-print flex flex-none">
                          <button className="icon-btn" aria-label={`Move ${v.ref_printed} up`} data-testid="workspace-up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                          <button className="icon-btn" aria-label={`Move ${v.ref_printed} down`} data-testid="workspace-down" disabled={i === picked.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                          <button className="icon-btn" aria-label={`Remove ${v.ref_printed}`} data-testid="workspace-remove" onClick={() => setPicked((p) => p.filter((x) => x !== id))}><X size={14} /></button>
                        </span>
                      </div>
                      <p className="m-0 mt-1 text-[13px] leading-relaxed" data-testid="workspace-text">{v.text}</p>
                      <p className="m-0 mt-1 text-xs leading-relaxed text-accent2">
                        <ContextLines verseKey={v.canonical_key} reference={v.ref_en} testId="workspace-context" />
                      </p>
                      <div className="mt-1">{contextButton(v.canonical_key, 'workspace-context-edit')}</div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="no-print mt-3 flex flex-wrap gap-1.5">
              <button
                className="btn btn-primary"
                data-testid="lecture-save"
                disabled={saving || !title.trim()}
                onClick={async () => {
                  setSaving(true);
                  try {
                    const saved = await api.saveLecture({ id: lectureId, ...lectureBody() });
                    setLectureId(saved.id);
                    setState({ lectures: [saved, ...getState().lectures.filter((l) => l.id !== saved.id)] });
                    toast('Lecture saved');
                  } catch (e) {
                    toast(errorText(e), 'error');
                  }
                  setSaving(false);
                }}
              >
                <Save size={14} /> {saving ? 'Saving' : 'Save'}
              </button>
              <button
                className="btn"
                data-testid="lecture-copy"
                disabled={picked.length === 0}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(asText());
                    toast('Lecture copied');
                  } catch {
                    toast('Your browser blocked copying.', 'error');
                  }
                }}
              >
                <Copy size={14} /> Copy
              </button>
              <button className="btn" data-testid="lecture-print" disabled={picked.length === 0} onClick={() => window.print()}>
                <Printer size={14} /> Print or save as PDF
              </button>
              <button
                className="btn"
                data-testid="lecture-export-word"
                disabled={picked.length === 0 || !title.trim() || exporting}
                title={title.trim() ? undefined : 'Give the lecture a title first'}
                onClick={async () => {
                  setExporting(true);
                  try {
                    const { blob, name } = await api.exportLecture(lectureBody());
                    saveFile(blob, name);
                    toast('Word file downloaded. It is not encrypted.');
                  } catch (e) {
                    toast(errorText(e), 'error');
                  }
                  setExporting(false);
                }}
              >
                <FileDown size={14} /> Word
              </button>
              <button className="btn" data-testid="lecture-present" disabled={slides.length === 0} onClick={() => setPresenting(true)}>
                <MonitorPlay size={14} /> Present
              </button>
            </div>
          </section>
          <section className="no-print rounded-lg border border-line bg-panel p-3" aria-label="Saved lectures" data-testid="saved-lectures">
            <h2 className="m-0 mb-2 text-[14px] font-semibold">Saved lectures ({lectures.length})</h2>
            {lectures.length === 0 && <p className="m-0 text-[13px] text-muted" data-testid="saved-empty">Nothing saved yet.</p>}
            <ul className="m-0 list-none space-y-1 p-0">
              {lectures.map((l) => (
                <li key={l.id} className={`flex items-center gap-1 rounded-md ${l.id === lectureId ? 'bg-raised' : ''}`} data-testid="saved-lecture">
                  <button className="tap min-h-9 min-w-0 flex-1 truncate rounded-md border-0 bg-transparent px-2 text-left text-[13px] hover:bg-raised max-lg:min-h-11" data-testid="saved-open" onClick={() => load(l)}>
                    {l.title} <span className="text-xs text-muted">· {l.verse_ids.length} {l.verse_ids.length === 1 ? 'verse' : 'verses'}</span>
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Delete ${l.title}`}
                    data-testid="saved-delete"
                    onClick={() =>
                      askConfirm({
                        title: 'Delete this lecture?',
                        body: `"${l.title}" will be removed. Its verses stay in the Bibles Library.`,
                        confirmLabel: 'Delete lecture',
                        onConfirm: async () => {
                          await api.deleteLecture(l.id);
                          if (l.id === lectureId) newLecture();
                          await refreshAll();
                        },
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
