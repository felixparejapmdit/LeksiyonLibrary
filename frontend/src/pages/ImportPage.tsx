import { useEffect } from 'react';
import { BookMarked, FileSpreadsheet } from 'lucide-react';
import { VerseImport } from '../components/VerseImport';
import { navigate } from '../store';

/** Opened with #rows-to-fix, the page starts at the rows left out of an import. */
export function ImportPage() {
  useEffect(() => {
    if (location.hash === '#rows-to-fix') requestAnimationFrame(() => document.querySelector('[data-testid="rows-to-fix"]')?.scrollIntoView({ block: 'start' }));
  }, []);
  return (
    <div className="scroll-stable h-full" data-testid="import-page">
      <div className="mx-auto max-w-3xl space-y-3 p-3 lg:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <FileSpreadsheet size={18} className="flex-none text-accent2" />
          <h1 className="m-0 text-lg font-semibold" data-testid="import-title">Import Verses</h1>
          <button className="btn ml-auto !min-h-[34px] max-lg:!min-h-11" data-testid="import-open-library" onClick={() => navigate('/bibles')}>
            <BookMarked size={14} /> Open the Verse Library
          </button>
        </div>
        <div className="rounded-lg border border-line bg-panel">
          <VerseImport />
        </div>
      </div>
    </div>
  );
}
