import { useEffect } from 'react';
import { BookMarked, FileSpreadsheet } from 'lucide-react';
import { VerseImport } from '../components/VerseImport';
import { PAGE, PageHeader } from '../components/PageHeader';
import { navigate } from '../store';

/** Opened with #rows-to-fix, the page starts at the rows left out of an import. */
export function ImportPage() {
  useEffect(() => {
    if (location.hash === '#rows-to-fix') requestAnimationFrame(() => document.querySelector('[data-testid="rows-to-fix"]')?.scrollIntoView({ block: 'start' }));
  }, []);
  return (
    <div className="scroll-stable h-full min-w-0" data-testid="import-page">
      <div className={PAGE}>
        <PageHeader
          icon={FileSpreadsheet}
          tone="pv"
          title="Import Verses"
          titleTestId="import-title"
          description="Verses from an Excel file go to the Verse Library, under Pastoral Visits."
          actions={
            <button className="btn" data-testid="import-open-library" onClick={() => navigate('/bibles')}>
              <BookMarked size={14} /> Open the Verse Library
            </button>
          }
        />
        <div className="card min-w-0 p-1 sm:p-2">
          <VerseImport />
        </div>
      </div>
    </div>
  );
}
