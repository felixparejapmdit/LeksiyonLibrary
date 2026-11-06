import { useEffect, useMemo, useRef, useState } from 'react';
import { BookMarked, BookOpen, ChevronsRight, ListChecks, Loader2, Lock, MapPin, ArrowRight } from 'lucide-react';
import { navigate, setState, setWelcomePref, useStore } from '../store';

/** Seconds before the welcome steps aside by itself, unless the pointer rests on it. */
const STAY_SECONDS = 9;

function greeting(hour: number) {
  if (hour < 12) return ['Good morning', 'Magandang umaga'];
  if (hour < 18) return ['Good afternoon', 'Magandang hapon'];
  return ['Good evening', 'Magandang gabi'];
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Shown as the app opens, over the vault while it unlocks and loads. It says what is
 * in the vault and where to start, then steps aside by itself. Skip closes it at once,
 * and it can be turned off here or in Settings.
 */
export function Welcome() {
  const booted = useStore((s) => s.booted);
  const lessons = useStore((s) => s.lessons);
  const verses = useStore((s) => s.verses);
  const remember = useStore((s) => s.welcomeOnOpen);
  const [leaving, setLeaving] = useState(false);
  const enterRef = useRef<HTMLButtonElement>(null);
  const [hello, halo] = useMemo(() => greeting(new Date().getHours()), []);
  const still = useMemo(reducedMotion, []);

  const stats = useMemo(() => {
    const visits = lessons.filter((l) => l.category === 'pastoral').length;
    return { lessons: lessons.length - visits, visits, verses: verses.length, toReview: verses.filter((v) => v.status === 'unverified').length };
  }, [lessons, verses]);

  const close = (path?: string) => {
    if (leaving) return;
    if (path) navigate(path);
    setLeaving(true);
    setTimeout(() => setState({ welcomeOpen: false }), still ? 0 : 260);
  };

  useEffect(() => {
    if (booted) enterRef.current?.focus({ preventScroll: true });
  }, [booted]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const tiles = [
    { label: 'Lessons', value: stats.lessons, icon: BookOpen, tone: 'tone-lessons' },
    { label: 'Pastoral visits', value: stats.visits, icon: MapPin, tone: 'tone-pv' },
    { label: 'Verses', value: stats.verses, icon: BookMarked, tone: 'tone-archive' },
    { label: 'To review', value: stats.toReview, icon: ListChecks, tone: 'tone-review' },
  ];

  return (
    <div className={`welcome fixed inset-0 z-[70] flex flex-col overflow-y-auto ${leaving ? 'is-leaving' : ''}`} role="dialog" aria-modal="true" aria-labelledby="welcome-title" data-testid="welcome">
      <div className="flex flex-none justify-end p-3">
        <button className="btn welcome-skip" data-testid="welcome-skip" onClick={() => close()}>
          Skip <ChevronsRight size={15} />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center px-4 pb-10">
        <div className="welcome-card w-full max-w-xl text-center">
          <div className="welcome-emblem welcome-in" aria-hidden="true">
            <span className="welcome-ring" />
            <span className="welcome-ring welcome-ring-2" />
            <span className="welcome-core">
              <BookOpen size={34} strokeWidth={1.75} />
            </span>
            <span className="welcome-lock">
              <Lock size={12} strokeWidth={2.5} />
            </span>
          </div>

          <p className="welcome-in m-0 mt-6 text-[13px] font-medium text-muted" style={{ animationDelay: '80ms' }} data-testid="welcome-greeting">
            {hello} <span className="opacity-60">·</span> <span lang="tl">{halo}</span>
          </p>
          <h1 id="welcome-title" className="welcome-in welcome-title m-0 mt-1 text-4xl font-bold tracking-tight max-sm:text-3xl" style={{ animationDelay: '140ms' }}>
            Lesson Vault
          </h1>
          <p className="welcome-in m-0 mx-auto mt-2 max-w-md text-[14px] text-muted" style={{ animationDelay: '200ms' }}>
            Your worship service lessons, pastoral visits and Bible verses, kept together, encrypted, and on this computer only.
          </p>

          <figure className="welcome-in welcome-verse m-0 mx-auto mt-5 max-w-md" style={{ animationDelay: '280ms' }}>
            <blockquote className="m-0 text-[15px] leading-relaxed italic">“Thy word is a lamp unto my feet, and a light unto my path.”</blockquote>
            <figcaption className="mt-1 text-xs text-muted">Psalm 119:105</figcaption>
          </figure>

          <div className="welcome-in mt-6 min-h-[76px]" style={{ animationDelay: '360ms' }}>
            {booted ? (
              <ul className="m-0 grid list-none grid-cols-4 gap-2 p-0 max-sm:grid-cols-2" data-testid="welcome-stats">
                {tiles.map(({ label, value, icon: Icon, tone }) => (
                  <li key={label} className={`welcome-tile ${tone}`}>
                    <Icon size={15} className="welcome-tile-icon" />
                    <span className="text-xl font-semibold tabular-nums" data-testid="welcome-stat">{value}</span>
                    <span className="text-[11px] text-muted">{label}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 flex items-center justify-center gap-2 pt-5 text-[13px] text-muted" data-testid="welcome-loading">
                <Loader2 size={15} className="animate-spin" /> Opening your encrypted vault…
              </p>
            )}
          </div>

          <div className="welcome-in mt-6 flex flex-wrap items-center justify-center gap-2" style={{ animationDelay: '440ms' }}>
            <button ref={enterRef} className="btn btn-primary !min-h-10 !px-4" data-testid="welcome-enter" disabled={!booted} onClick={() => close()}>
              Open the vault <ArrowRight size={15} />
            </button>
            {booted && stats.toReview > 0 && (
              <button className="btn !min-h-10 !px-4" data-testid="welcome-review" onClick={() => close('/review')}>
                <ListChecks size={15} /> Review {stats.toReview} {stats.toReview === 1 ? 'verse' : 'verses'}
              </button>
            )}
          </div>

          <label className="welcome-in mt-5 inline-flex items-center gap-2 text-xs text-muted" style={{ animationDelay: '500ms' }}>
            <input type="checkbox" data-testid="welcome-remember" checked={remember} onChange={(e) => setWelcomePref(e.target.checked)} />
            Show this when the app opens
          </label>

          {/* Steps aside by itself; resting the pointer on the welcome holds it. */}
          {booted && !still && (
            <div className="welcome-timer mx-auto mt-5 h-1 w-40 overflow-hidden rounded-full bg-raised" aria-hidden="true">
              <span className="block h-full rounded-full" style={{ animationDuration: `${STAY_SECONDS}s` }} data-testid="welcome-timer" onAnimationEnd={() => close()} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
