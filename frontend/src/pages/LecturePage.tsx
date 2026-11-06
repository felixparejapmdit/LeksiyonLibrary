import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, BookMarked, ChevronDown, Copy, MapPin, FileDown, FilePlus2, FileText, Loader2, Lock, MonitorPlay, PencilLine, Plus, Printer, Save, Sparkles, Trash2, X } from 'lucide-react';
import { PresentationMode } from '../components/Presentation';
import { backgroundAsText, backgroundOf, ContextPanel } from '../components/VerseContext';
import { api, saveFile, type Lecture, type LessonMatch, type Suggestion, type Verse } from '../api';
import { askConfirm, errorText, getState, libraryOf, partName, refreshAll, setState, toast, useStore } from '../store';

type NotesStatus = 'idle' | 'loading' | 'ready' | 'offline';
type Group = {
  title: string | null;
  objective: string;
  /** Verses asked for at a time. */
  count: number;
  logId: string;
  suggestions: Suggestion[];
  status: NotesStatus;
  notes: Record<string, string>;
  /** Asking for more found nothing new. */
  exhausted: boolean;
  loadingMore: boolean;
};
/** A lecture has up to four objectives, and each is given up to five verses at a time. */
const MAX_OBJECTIVES = 4;
const PER_OBJECTIVE = 5;
/** Fewer than this many found is said, rather than padded with verses that do not match. */
const MIN_PER_OBJECTIVE = 3;

const objectiveLines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Where a verse came from, so verses from the two libraries are never mixed up: the
 * Verse Library (imported from a sheet or read from a pastoral visit) or the Lesson
 * Library (read from a worship service lesson PDF).
 */
export function VerseOrigin({ verse }: { verse: Verse }) {
  const lessons = useStore((s) => s.lessons);
  const cited = verse.sources.flatMap((s) => {
    const lesson = lessons.find((l) => l.id === s.lesson_id);
    return lesson ? [{ lesson, page: s.page, pastoral: s.pastoral }] : [];
  });
  const visits = cited.filter((c) => c.pastoral);
  const badge = 'inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium';
  return (
    <span className="flex min-w-0 flex-wrap gap-1" data-testid="verse-origin">
      {libraryOf(verse) === 'verse' && (verse.import_source || visits.length === 0) && (
        <span className={`${badge} border-accent2/60 text-accent2`} data-testid="origin-verse-library" title={verse.import_source ? `Imported from ${verse.import_source}` : 'Kept in the Verse Library'}>
          <BookMarked size={11} className="flex-none" /><span className="truncate">Verse Library{verse.import_source ? ` · ${verse.import_source}` : ''}</span>
        </span>
      )}
      {visits.map(({ lesson, page }) => (
        <span key={lesson.id} className={`${badge} border-accent2/60 text-accent2`} data-testid="origin-pastoral" title={`Read from the pastoral visit ${lesson.title}, page ${page}`}>
          <MapPin size={11} className="flex-none" /><span className="truncate">Verse Library · Pastoral visit: {lesson.title}, p.{page}</span>
        </span>
      ))}
      {cited.filter((c) => !c.pastoral).map(({ lesson, page }) => (
        <span key={lesson.id} className={`${badge} border-pv/60 text-pv`} data-testid="origin-lesson-library" title={`Read from ${lesson.title}, page ${page}`}>
          <FileText size={11} className="flex-none" /><span className="truncate">Lesson Library · {lesson.title}, p.{page}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * The lessons a suggestion was found in, for the objective or topic asked about: the lesson,
 * its PDF file, the part of the lesson and the question the verse answers there.
 */
function FoundInLessons({ found }: { found: LessonMatch[] }) {
  const lessons = useStore((s) => s.lessons);
  if (found.length === 0) return null;
  return (
    <ul className="m-0 mb-2 list-none space-y-1 rounded-md border border-pv/40 bg-pv/5 p-2 text-xs" data-testid="suggestion-lessons" aria-label="Found in these lessons">
      {found.map((m) => {
        const lesson = lessons.find((l) => l.id === m.lesson_id);
        const part = partName(m.section, lesson?.language ?? 'en', lesson?.objectives.length ?? 0);
        return (
          <li key={m.lesson_id} className="min-w-0" data-testid="suggestion-from-lesson">
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
              {m.pastoral ? <MapPin size={12} className="flex-none text-pv" /> : <FileText size={12} className="flex-none text-pv" />}
              <span className="text-muted" data-testid="from-lesson-kind">{m.pastoral ? 'Pastoral visit' : 'Lesson'}</span>
              <span className="font-semibold text-fg" data-testid="from-lesson-title">{m.title}</span>
              <span className="text-muted" data-testid="from-lesson-file">{m.file_name}</span>
              {part && <span className="text-pv" data-testid="from-lesson-part">{part}</span>}
            </span>
            {m.objective && <span className="mt-0.5 block text-muted" data-testid="from-lesson-objective">The lesson's objective: {m.objective}</span>}
            {m.question && <span className="mt-0.5 block text-muted" data-testid="from-lesson-question">Under the question: {m.question}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function ReadOnlyVerse({ verse }: { verse: Verse }) {
  return (
    <div className="rounded-md border border-line p-2" data-testid="suggested-verse" data-verse-id={verse.id}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Lock size={11} />
        <span className="font-semibold text-fg">{verse.language === 'tl' ? 'Tagalog' : 'English'}</span>
        {verse.version && <span>{verse.version}</span>}
        <span data-testid="suggested-status">{verse.status === 'verified' ? 'Verified' : verse.import_source ? 'Unverified import' : 'Unverified scan'}</span>
      </div>
      <div className="mb-1.5"><VerseOrigin verse={verse} /></div>
      <p className="m-0 text-[13px] leading-relaxed" data-testid="suggested-text">{verse.text || 'Reference only.'}</p>
    </div>
  );
}

/** One per language shows first, so a verse held in many translations does not fill the page. */
function firstOfEachLanguage(items: Verse[]) {
  const first = new Set<string>();
  for (const language of ['tl', 'en']) {
    const v = items.find((x) => x.language === language);
    if (v) first.add(v.id);
  }
  return items.filter((v) => first.has(v.id));
}

export function LecturePage() {
  const verses = useStore((s) => s.verses);
  const lectures = useStore((s) => s.lectures);
  const byId = useMemo(() => new Map(verses.map((v) => [v.id, v])), [verses]);
  const [lectureId, setLectureId] = useState<string | undefined>();
  const [title, setTitle] = useState('');
  const [issue, setIssue] = useState('');
  const [objectives, setObjectives] = useState<string[]>(['']);
  // Stored with a lecture as one objective per line.
  const objective = objectives.map((o) => o.trim()).filter(Boolean).join('\n');
  const [picked, setPicked] = useState<string[]>([]);
  // The objective each picked verse was chosen for, kept when a lecture is saved.
  const [objectiveOf, setObjectiveOf] = useState<Record<string, string>>({});
  const [presenting, setPresenting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [groups, setGroups] = useState<Group[] | null>(null);
  // With more than one objective, each has its own tab, so switching never needs scrolling.
  const [activeTab, setActiveTab] = useState(0);
  const tabsRef = useRef<HTMLDivElement>(null);
  // The issue the shown suggestions were found for: objectives already answered for it are kept.
  const groupsIssue = useRef('');
  const contexts = useStore((s) => s.contexts);
  const scripture = useStore((s) => s.scripture);
  const tagalog = useStore((s) => s.tagalog);
  const contextLanguage = useStore((s) => s.contextLanguage);
  const [allTranslations, setAllTranslations] = useState<Record<string, boolean>>({});
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
      const wanted: { title: string; objective: string }[] = lines.length > 0 ? lines.map((l) => ({ title: l, objective: l })) : [{ title: issue.trim(), objective: '' }];
      // An objective added later gets its own verses; those already found for the others stay.
      const kept = groupsIssue.current === issue.trim() ? (groups ?? []) : [];
      const reused = wanted.map((w) => kept.find((g) => g.title === w.title && g.objective === w.objective && g.status !== 'loading'));
      // Matches appear right away; AI notes fill in afterwards without moving anything.
      const found = await Promise.all(wanted.map((w, i) => (reused[i] ? null : api.aiSuggest(issue, w.objective, PER_OBJECTIVE))));
      if (seq !== requestSeq.current) return;
      const next: Group[] = wanted.map((w, i) => {
        const f = found[i];
        if (!f) return reused[i]!;
        const fresh: Group = { title: w.title, objective: w.objective, count: PER_OBJECTIVE, logId: f.log_id, suggestions: f.suggestions, status: f.suggestions.length ? 'loading' : 'idle', notes: {}, exhausted: false, loadingMore: false };
        return fresh;
      });
      groupsIssue.current = issue.trim();
      setGroups(next);
      // The first objective that was just asked about opens; otherwise the open tab stays.
      const firstNew = found.findIndex((f) => f);
      setActiveTab((t) => (kept.length === 0 ? 0 : firstNew >= 0 ? firstNew : t < next.length ? t : 0));
      if (found.some((f) => f)) setUsedMeaning(found.some((f) => f?.meaning));
      setSearching(false);
      // One objective at a time: the local model can only do one well on a CPU.
      for (let i = 0; i < next.length; i++) {
        if (!found[i] || next[i].suggestions.length === 0) continue;
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

  /** More verses for one objective, leaving out those it already shows. */
  const suggestMore = async (groupIndex: number) => {
    const seq = requestSeq.current;
    const g = groups?.[groupIndex];
    if (!g) return;
    const patch = (p: Partial<Group> | ((x: Group) => Partial<Group>)) =>
      setGroups((all) => all && all.map((x, n) => (n === groupIndex ? { ...x, ...(typeof p === 'function' ? p(x) : p) } : x)));
    patch({ loadingMore: true });
    try {
      const found = await api.aiSuggest(issue, g.objective, g.count, g.suggestions.map((s) => s.canonical_key));
      if (seq !== requestSeq.current) return;
      const fresh = found.suggestions.filter((s) => !g.suggestions.some((x) => x.canonical_key === s.canonical_key));
      patch((x) => ({ suggestions: [...x.suggestions, ...fresh], exhausted: fresh.length === 0, loadingMore: false }));
      if (fresh.length === 0) return;
      const n = await api.aiNotes(found.log_id);
      if (seq !== requestSeq.current || !n.available) return;
      patch((x) => ({ notes: { ...x.notes, ...n.notes } }));
      setState({ contexts: n.context, scripture: n.scripture });
    } catch (err) {
      patch({ loadingMore: false });
      toast(errorText(err), 'error');
    }
  };

  const newLecture = () => {
    setLectureId(undefined);
    setTitle('');
    setIssue('');
    setObjectives(['']);
    setPicked([]);
    setObjectiveOf({});
    setGroups(null);
    setActiveTab(0);
  };

  const load = (l: Lecture) => {
    setLectureId(l.id);
    setTitle(l.title);
    setIssue(l.issue);
    const lines = objectiveLines(l.objective);
    setObjectives(lines.length ? lines : ['']);
    setPicked(l.verse_ids);
    setObjectiveOf(Object.fromEntries(l.verse_ids.map((id, i) => [id, l.verse_objectives[i] ?? ''])));
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
  const contextState = { contexts, scripture, tagalog };
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
          ...backgroundAsText(backgroundOf(contextState, v.canonical_key, contextLanguage), contextLanguage),
          '',
        ];
      }),
    ].join('\n');
  };

  const contextButton = (key: string, testId: string) => {
    const c = backgroundOf(contextState, key, contextLanguage);
    return (
      <button className="btn no-print !min-h-7 max-lg:!min-h-11" data-testid={testId} onClick={() => setState({ editingContextKey: key })}>
        <PencilLine size={12} /> {c.empty ? 'Add speaker and context' : c.reviewed ? 'Edit context' : 'Review or correct'}
      </button>
    );
  };

  const tabbed = !!groups && groups.length > 1 && groups.some((g) => g.suggestions.length > 0);
  const shownTab = groups && activeTab < groups.length ? activeTab : 0;

  return (
    <div className="scroll-stable h-full" data-testid="lecture-page">
      {presenting && <PresentationMode title={title || 'Lecture'} slides={slides} onClose={() => setPresenting(false)} />}
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 p-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:p-4">
        <div className="min-w-0 space-y-3">
          <div className="no-print">
            <h1 className="m-0 text-lg font-semibold">Lesson Assistant <span className="text-[13px] font-normal text-muted">· Lecture Maker</span></h1>
            <p className="m-0 mt-0.5 text-[13px] text-muted" data-testid="lecture-intro">
              Describe the issue and objective. Suggestions come from the verses in both your Verse Library and your Lesson Library, shown exactly as stored, and each one is labelled with where it came from.
            </p>
          </div>
          <form className="no-print space-y-3 rounded-lg border border-line bg-panel p-3" onSubmit={suggest}>
            <label className="block text-xs text-muted">
              Issue or topic
              <textarea className="field mt-1 min-h-16" data-testid="lecture-issue" placeholder="What situation should this lecture address?" value={issue} onChange={(e) => setIssue(e.target.value)} />
            </label>
            <fieldset className="m-0 space-y-2 border-0 p-0" data-testid="lecture-objectives">
              <legend className="mb-1.5 p-0 text-xs text-muted">Objectives: up to {MAX_OBJECTIVES}, each given 3 to 5 verses</legend>
              {objectives.map((o, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-5 flex-none text-right text-xs text-muted tabular-nums">{i + 1}.</span>
                  <input
                    className="field"
                    data-testid="lecture-objective"
                    aria-label={`Objective ${i + 1}`}
                    placeholder={i === 0 ? 'What should listeners understand or do?' : 'Another objective'}
                    value={o}
                    onChange={(e) => setObjectives((all) => all.map((x, n) => (n === i ? e.target.value : x)))}
                  />
                  {objectives.length > 1 && (
                    <button
                      type="button"
                      className="icon-btn flex-none"
                      aria-label={`Remove objective ${i + 1}`}
                      data-testid="lecture-objective-remove"
                      onClick={() => {
                        const removed = o.trim();
                        setObjectives((all) => all.filter((_, n) => n !== i));
                        setGroups((g) => g && g.filter((x) => x.title !== removed));
                        setActiveTab(0);
                      }}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="btn ml-[26px] !min-h-8 border-dashed max-lg:!min-h-11"
                data-testid="lecture-objective-add"
                disabled={objectives.length >= MAX_OBJECTIVES}
                onClick={() => setObjectives((all) => [...all, ''])}
              >
                <Plus size={13} /> Add objective <span className="ml-1 text-xs text-muted tabular-nums">{objectives.length} of {MAX_OBJECTIVES}</span>
              </button>
            </fieldset>
            <div className="-mx-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3 pt-3" data-testid="lecture-actions">
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
                {groups.some((g) => g.status === 'loading') && <span className="flex items-center gap-1" data-testid="notes-loading"><Loader2 size={12} className="animate-spin" /> Writing AI notes and context. This can take a few minutes the first time; keep working.</span>}
                {groups.some((g) => g.status === 'offline') && <span data-testid="notes-offline">AI notes and context unavailable</span>}
              </div>
              <p className="m-0 text-xs text-muted" data-testid="match-mode">{usedMeaning ? 'Matched by meaning and words' : 'Matched by words only'}</p>
              {groups.every((g) => g.suggestions.length === 0) && <p className="m-0 rounded-lg border border-line p-4 text-center text-[13px] text-muted" data-testid="suggestions-empty">No verses in your library match. Try other words, or upload more lessons.</p>}
              {tabbed && (
                <div
                  ref={tabsRef}
                  className="sticky top-0 z-10 -mx-1 flex gap-1 overflow-x-auto border-b border-line bg-bg px-1 pt-1"
                  role="tablist"
                  aria-label="Objectives"
                  data-testid="objective-tabs"
                  onKeyDown={(e) => {
                    // Arrow keys move between tabs, as in any tab list.
                    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                    e.preventDefault();
                    const next = (shownTab + (e.key === 'ArrowRight' ? 1 : groups.length - 1)) % groups.length;
                    setActiveTab(next);
                    tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                  }}
                >
                  {groups.map((g, i) => {
                    const chosen = g.suggestions.reduce((n, s) => n + s.verse_ids.filter((id) => picked.includes(id)).length, 0);
                    return (
                      <button
                        key={i}
                        type="button"
                        role="tab"
                        id={`objective-tab-${i}`}
                        aria-selected={i === shownTab}
                        aria-controls={`objective-panel-${i}`}
                        tabIndex={i === shownTab ? 0 : -1}
                        title={g.title ?? undefined}
                        className={`tap -mb-px flex max-w-64 min-w-0 flex-none items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 py-1.5 text-left text-xs max-lg:min-h-11 ${i === shownTab ? 'border-line bg-panel font-semibold text-fg' : 'border-transparent bg-transparent text-muted hover:text-fg'}`}
                        data-testid="objective-tab"
                        onClick={() => setActiveTab(i)}
                      >
                        <span className="flex-none text-accent2 tabular-nums">{i + 1}.</span>
                        <span className="min-w-0 truncate">{g.title}</span>
                        <span className="flex-none rounded-full bg-raised px-1.5 text-[11px] font-normal text-muted tabular-nums" data-testid="objective-tab-count" title={`${g.suggestions.length} suggested${chosen ? `, ${chosen} added to the lecture` : ''}`}>
                          {chosen ? `${chosen}/` : ''}{g.suggestions.length}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {groups.some((g) => g.suggestions.length > 0) && groups.map((g, groupIndex) => (
              <div
                key={groupIndex}
                className="space-y-2"
                data-testid="objective-group"
                hidden={tabbed && groupIndex !== shownTab}
                {...(tabbed ? { role: 'tabpanel', id: `objective-panel-${groupIndex}`, 'aria-labelledby': `objective-tab-${groupIndex}` } : {})}
              >
                {g.title && (
                  <div className="mt-3 first:mt-0">
                    <h3 className="m-0 text-[13px] font-semibold text-accent2" data-testid="objective-title">{g.title}</h3>
                    {g.suggestions.length < MIN_PER_OBJECTIVE && (
                      <p className="m-0 text-xs text-muted" data-testid="objective-shortfall">
                        {g.suggestions.length === 0 ? 'No verses in your libraries match this objective.' : `Only ${g.suggestions.length} found in your libraries.`}
                      </p>
                    )}
                  </div>
                )}
              {g.suggestions.map((s) => {
                const items = s.verse_ids.map((id) => byId.get(id)).filter((v): v is Verse => !!v);
                const showAll = allTranslations[s.canonical_key] || items.length <= 2;
                const visible = showAll ? items : firstOfEachLanguage(items);
                return (
                  <article key={s.canonical_key} className="rounded-lg border border-line bg-panel p-3" data-testid="suggestion" data-key={s.canonical_key}>
                    <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                      <h3 className="m-0 text-[14px] font-semibold" data-testid="suggestion-ref">{s.ref_en}</h3>
                      {s.ref_tl !== s.ref_en && <span className="text-xs text-muted">{s.ref_tl}</span>}
                      {s.matched_terms.length > 0 && <span className="text-xs text-muted">Matches: {s.matched_terms.join(', ')}</span>}
                      {s.meaning && <span className="text-xs text-muted" data-testid="suggestion-meaning">Related in meaning</span>}
                    </div>
                    <FoundInLessons found={s.from_lessons ?? []} />
                    <ContextPanel verseKey={s.canonical_key} reference={s.ref_en} referenceTl={s.ref_tl} testId="verse-context" note={g.notes[s.canonical_key]}>
                      <div className="mb-2">{contextButton(s.canonical_key, 'context-edit')}</div>
                    </ContextPanel>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      {visible.map((v) => (
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
                    {!showAll && visible.length < items.length && (
                      <button className="btn mt-2 !min-h-8 max-lg:!min-h-11" data-testid="suggestion-more" onClick={() => setAllTranslations((a) => ({ ...a, [s.canonical_key]: true }))}>
                        Show {items.length - visible.length} more {items.length - visible.length === 1 ? 'translation' : 'translations'}
                      </button>
                    )}
                  </article>
                );
              })}
              {g.suggestions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="objective-more" disabled={g.loadingMore || g.exhausted} onClick={() => suggestMore(groupIndex)}>
                    {g.loadingMore ? <Loader2 size={13} className="animate-spin" /> : <ChevronDown size={13} />} Suggest more{g.objective ? ' for this objective' : ''}
                  </button>
                  {g.exhausted && <span className="text-xs text-muted" data-testid="objective-no-more">No more verses in your libraries match. Try other words.</span>}
                </div>
              )}
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
                      <div className="no-print mt-1"><VerseOrigin verse={v} /></div>
                      <p className="m-0 mt-1 text-[13px] leading-relaxed" data-testid="workspace-text">{v.text}</p>
                      <ContextPanel verseKey={v.canonical_key} reference={v.ref_en} referenceTl={v.ref_tl} testId="workspace-context">
                        <div className="mt-1">{contextButton(v.canonical_key, 'workspace-context-edit')}</div>
                      </ContextPanel>
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
                    const { blob, name } = await api.exportLecture({ ...lectureBody(), context_language: contextLanguage });
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
                        body: `"${l.title}" will be removed. Its verses stay in your libraries.`,
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
