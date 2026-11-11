import { Search } from 'lucide-react';
import { GlobalSearchContent } from '../components/AdvancedSearch';
import { PAGE, PageHeader } from '../components/PageHeader';

export function SearchPage() {
  return (
    <div className="scroll-stable h-full min-w-0" data-testid="search-page">
      <div className={PAGE}>
        <PageHeader icon={Search} tone="lessons" title="Search" description="Search lessons, document text, verses, issues, objectives, local congregations, and districts in English or Tagalog. Open search anywhere with Ctrl+K." />
        <GlobalSearchContent />
      </div>
    </div>
  );
}
