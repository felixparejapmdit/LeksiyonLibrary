import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Sidebar } from './Sidebar';

const DESKTOP = '(min-width: 1024px)';

export function useIsDesktop() {
  const [desktop, setDesktop] = useState(() => matchMedia(DESKTOP).matches);
  useEffect(() => {
    const m = matchMedia(DESKTOP);
    const fn = () => setDesktop(m.matches);
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, []);
  return desktop;
}

/**
 * Renders long lists in small batches across frames, so that opening a large
 * library never blocks input. Lists shorter than one batch render in full at once.
 */
export function useProgressive<T>(items: T[], step: number): T[] {
  const [limit, setLimit] = useState(step);
  const [source, setSource] = useState(items);
  if (source !== items) {
    setSource(items);
    setLimit(step);
  }
  useEffect(() => {
    if (limit >= items.length) return;
    const id = requestAnimationFrame(() => setLimit((l) => l + step));
    return () => cancelAnimationFrame(id);
  }, [limit, items.length, step]);
  return limit >= items.length ? items : items.slice(0, limit);
}

function readWidth(key: string, fallback: number) {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Writes CSS variables directly while dragging, so the drag skips React entirely. */
export function ResizeHandle({ variable, storageKey, edge, min, max, label, testId }: { variable: string; storageKey: string; edge: 'left' | 'right'; min: number; max: number; label: string; testId: string }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const root = e.currentTarget.closest<HTMLElement>('[data-frame-root]');
    if (!root) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    // Start from the pane's real width: a stored width may exceed what the window allows.
    const pane = (edge === 'left' ? handle.previousElementSibling : handle.nextElementSibling) as HTMLElement | null;
    const start = pane?.getBoundingClientRect().width ?? parseFloat(getComputedStyle(root).getPropertyValue(variable));
    let raf = 0;
    let latest = start;
    const move = (ev: PointerEvent) => {
      const delta = edge === 'left' ? ev.clientX - startX : startX - ev.clientX;
      latest = Math.min(max, Math.max(min, start + delta));
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          root.style.setProperty(variable, `${latest}px`);
        });
      }
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      requestAnimationFrame(() => {
        const settled = pane?.getBoundingClientRect().width ?? latest;
        root.style.setProperty(variable, `${settled}px`);
        localStorage.setItem(storageKey, String(Math.round(settled)));
      });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-testid={testId}
      className="tap w-1.5 flex-none cursor-col-resize touch-none border-x border-transparent bg-line/40 hover:bg-accent2/60"
      onPointerDown={onPointerDown}
    />
  );
}

/** On desktop the sidebar persists across pages, so navigation is always one click away. */
export function DesktopFrame({ children }: { children: React.ReactNode }) {
  const desktop = useIsDesktop();
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  // The same structure at every width: the page must not be rebuilt when the window
  // narrows or a print layout begins, or an unsaved lecture would be lost.
  return (
    <div
      data-frame-root
      className="flex h-full min-w-0"
      style={{ '--sidebar-w': `${readWidth('lv.sidebarW', 260)}px`, '--viewer-w': `${readWidth('lv.viewerW', 560)}px` } as React.CSSProperties}
    >
      {desktop && sidebarOpen && (
        <>
          <div className="min-w-0 flex-none" style={{ width: 'var(--sidebar-w)' }}>
            <Sidebar />
          </div>
          <ResizeHandle variable="--sidebar-w" storageKey="lv.sidebarW" edge="left" min={190} max={420} label="Resize sidebar" testId="resize-sidebar" />
        </>
      )}
      <div className="h-full min-w-0 flex-1">{children}</div>
    </div>
  );
}
