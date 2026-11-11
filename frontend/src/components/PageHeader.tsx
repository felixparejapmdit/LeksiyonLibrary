import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export type Tone = 'archive' | 'lessons' | 'pv' | 'assist' | 'review' | 'warn';

/**
 * Every page opens the same way: an icon tile in the colour its part has in the sidebar,
 * the title, a line saying what the page is for, and the page's own actions on the right.
 */
export function PageHeader({ icon: Icon, tone, title, subtitle, description, actions, titleTestId, descriptionTestId }: { icon: LucideIcon; tone: Tone; title: string; subtitle?: string; description?: ReactNode; actions?: ReactNode; titleTestId?: string; descriptionTestId?: string }) {
  return (
    <header className="mb-6 grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:gap-x-4">
      <span className={`page-tile tone-${tone}`} aria-hidden="true">
        <Icon size={19} />
      </span>
      <div className="min-w-0">
        <h1 className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xl leading-tight font-semibold tracking-tight break-words" data-testid={titleTestId}>
          {title}
          {subtitle && <span className="text-[13px] font-normal tracking-normal text-muted">{subtitle}</span>}
        </h1>
        {description && (
          <div className="m-0 mt-1 max-w-3xl text-[13px] leading-relaxed text-muted" data-testid={descriptionTestId}>
            {description}
          </div>
        )}
      </div>
      {actions && <div className="col-start-2 flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:col-start-auto sm:justify-end">{actions}</div>}
    </header>
  );
}

/** The same frame on every page: one width, and the same space around the content. */
export const PAGE = 'page-frame mx-auto w-full max-w-[1680px]';
