import { CalendarPlus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { askConfirm, setState, useStore } from '../store';

export const formatDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Where and when each lesson was given, to help avoid repeating one. */
export function HistoryPage() {
  const teachings = useStore((s) => s.teachings);
  const lessons = useStore((s) => s.lessons);
  const titleOf = (id: string) => lessons.find((l) => l.id === id)?.title ?? 'Lesson';
  return (
    <div className="scroll-stable h-full" data-testid="history-page">
      <div className="mx-auto max-w-3xl space-y-3 p-3 lg:p-4">
        <div className="flex items-center justify-between gap-2">
          <h1 className="m-0 text-lg font-semibold">Teaching history</h1>
          <button className="btn btn-primary" data-testid="history-add" disabled={lessons.length === 0} onClick={() => setState({ teachingDialog: { lessonId: '' } })}>
            <CalendarPlus size={14} /> Record a teaching
          </button>
        </div>
        {teachings.length === 0 ? (
          <p className="py-14 text-center text-[13px] text-muted" data-testid="history-empty">Nothing recorded yet. Record when and where you give a lesson, so you can avoid repeating it.</p>
        ) : (
          <ul className="m-0 list-none space-y-2 p-0" data-testid="history-list">
            {teachings.map((t) => (
              <li key={t.id} className="flex items-start gap-2 rounded-lg border border-line bg-panel p-3" data-testid="history-item">
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-xs text-muted" data-testid="history-when">{formatDay(t.taught_on)}{t.place ? ` · ${t.place}` : ''}</p>
                  <p className="m-0 mt-0.5 font-medium" data-testid="history-lesson">{titleOf(t.lesson_id)}</p>
                  {t.notes && <p className="m-0 mt-1 text-[13px] whitespace-pre-wrap text-muted" data-testid="history-notes">{t.notes}</p>}
                </div>
                <button
                  className="icon-btn"
                  aria-label={`Delete record for ${titleOf(t.lesson_id)}`}
                  data-testid="history-delete"
                  onClick={() =>
                    askConfirm({
                      title: 'Delete this record?',
                      body: `The record of teaching "${titleOf(t.lesson_id)}" on ${formatDay(t.taught_on)} will be removed. The lesson stays in your vault.`,
                      confirmLabel: 'Delete record',
                      onConfirm: async () => setState({ teachings: await api.deleteTeaching(t.id) }),
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
