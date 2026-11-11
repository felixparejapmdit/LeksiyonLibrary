import { useState } from 'react';
import { Pencil } from 'lucide-react';
import type { Lesson } from '../api';
import { documentLabel } from '../documents';
import { setState } from '../store';

function storedOpen() {
  try { return localStorage.getItem('lv.summary') === '1'; } catch { return false; }
}

/** Shared metadata beside both PDF and Word originals. */
export function LessonSummary({ lesson }: { lesson: Lesson }) {
  const [open, setOpen] = useState(storedOpen);
  const tagalog = lesson.language === 'tl';
  const empty = !lesson.issue && lesson.objectives.length === 0;
  return <details className="no-print flex-none border-b border-line bg-panel text-[13px]" data-testid="lesson-summary" open={open}
    onToggle={(e) => {
      const next = e.currentTarget.open;
      setOpen(next);
      try { localStorage.setItem('lv.summary', next ? '1' : '0'); } catch { /* memory-only in private mode */ }
    }}>
    <summary className="tap cursor-pointer px-3 py-1.5 text-xs font-semibold text-muted max-lg:py-3" data-testid="lesson-summary-toggle">
      {tagalog ? 'Isyu at Mga Layunin' : 'Issue and Objectives'}
    </summary>
    <div className="max-h-[40vh] overflow-auto px-3 pb-2" data-testid="lesson-summary-body">
      {empty ? <p className="m-0 text-muted" data-testid="lesson-summary-empty">None found in this {documentLabel(lesson)}. You can add them.</p> : <>
        {lesson.issue && <>
          <h3 className="m-0 text-xs font-semibold">{tagalog ? 'Isyu' : 'Issue'}</h3>
          <p className="m-0 mb-2 leading-relaxed" data-testid="lesson-issue">{lesson.issue}</p>
        </>}
        {lesson.objectives.length > 0 && <>
          <h3 className="m-0 text-xs font-semibold">{tagalog ? 'Mga Layunin' : 'Objectives'}</h3>
          <ol className="m-0 mb-2 pl-5 leading-relaxed" data-testid="lesson-objectives">
            {lesson.objectives.map((objective, i) => <li key={i} data-testid="lesson-objective">{objective}</li>)}
          </ol>
        </>}
      </>}
      <button className="btn !min-h-8 max-lg:!min-h-11" data-testid="lesson-summary-edit" onClick={() => setState({ editingLessonId: lesson.id })}>
        <Pencil size={13} /> {empty ? 'Add' : 'Edit'}
      </button>
    </div>
  </details>;
}
