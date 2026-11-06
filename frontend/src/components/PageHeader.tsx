import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export type Tone = 'archive' | 'lessons' | 'pv' | 'assist' | 'review' | 'warn';

/**
 * Every page opens the same way: an icon tile in the colour its part has in the sidebar,
 * the title, a line saying what the page is for, and the page's own actions on the right.
 */
export function PageHeader({ icon: Icon, tone, title, subtitle, description, actions, titleTestId, descriptionTestId }: { icon: LucideIcon; tone: Tone; title: string; subtitle?: string; description?: ReactNode; actions?: ReactNode; titleTestId?: string; descriptionTestId?: string }) {
  return (
    <header className="mb-5 flex flex-wrap items-start gap-x-3.5 gap-y-3">
      <span className={`page-tile tone-${tone}`} aria-hidden="true">
        <Icon size={19} />
      </span>
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="m-0 text-xl leading-tight font-semibold tracking-tight" data-testid={titleTestId}>
          {title}
          {subtitle && <span className="ml-2 text-[13px] font-normal tracking-normal text-muted">{subtitle}</span>}
        </h1>
        {description && (
          <div className="m-0 mt-1 max-w-3xl text-[13px] leading-relaxed text-muted" data-testid={descriptionTestId}>
            {description}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** The same frame on every page: one width, and the same space around the content. */
export const PAGE = 'mx-auto w-full max-w-[1680px] px-4 py-5 lg:px-8 lg:py-6';
