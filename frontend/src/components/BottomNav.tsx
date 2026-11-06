import { BookMarked, FolderOpen, Search, Settings, Sparkles } from 'lucide-react';
import { navigate, useRoute } from '../store';

const items = [
  { path: '/', label: 'Lessons', icon: FolderOpen, id: 'vault' },
  { path: '/bibles', label: 'Verses', icon: BookMarked, id: 'bibles' },
  { path: '/lecture', label: 'Assistant', icon: Sparkles, id: 'lecture' },
  { path: '/search', label: 'Search', icon: Search, id: 'search' },
  { path: '/settings', label: 'Settings', icon: Settings, id: 'settings' },
];

export function BottomNav() {
  const route = useRoute();
  return (
    <nav className="no-print safe-bottom flex-none border-t border-line bg-panel lg:hidden" aria-label="Primary" data-testid="bottom-nav">
      <div className="grid h-14 grid-cols-5">
        {items.map(({ path, label, icon: Icon, id }) => {
          const active = route === path;
          return (
            <button
              key={path}
              className={`tap flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${active ? 'text-accent2' : 'text-muted'}`}
              aria-current={active ? 'page' : undefined}
              data-testid={`nav-${id}`}
              onClick={() => navigate(path)}
            >
              <Icon size={20} />
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
