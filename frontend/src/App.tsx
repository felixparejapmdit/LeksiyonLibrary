import { boot, useStore, useRoute } from './store';
import { VaultPage } from './pages/VaultPage';
import { BiblesPage } from './pages/BiblesPage';
import { LecturePage } from './pages/LecturePage';
import { SettingsPage } from './pages/SettingsPage';
import { SearchPage } from './pages/SearchPage';
import { Header } from './components/Header';
import { BottomNav } from './components/BottomNav';
import { DesktopFrame } from './components/Layout';
import { BackupDialog, ConfirmDialog, EditLessonDialog, ToastRegion, UploadDialog } from './components/Overlays';

function Page() {
  const route = useRoute();
  switch (route) {
    case '/bibles':
      return <BiblesPage />;
    case '/lecture':
      return <LecturePage />;
    case '/settings':
      return <SettingsPage />;
    case '/search':
      return <SearchPage />;
    default:
      return <VaultPage />;
  }
}

export default function App() {
  const booted = useStore((s) => s.booted);
  const bootError = useStore((s) => s.bootError);

  if (bootError) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center p-6 text-center" data-testid="boot-error">
        <h1 className="m-0 text-lg font-semibold">Cannot reach Lesson Vault</h1>
        <p className="m-0 mt-1 mb-4 text-[13px] text-muted">Your data has not been affected. Check that the app is running, then try again.</p>
        <button className="btn btn-primary" data-testid="boot-retry" onClick={() => void boot()}>Try again</button>
      </div>
    );
  }
  // Nothing is painted until the vault has loaded, so an empty vault never flashes.
  if (!booted) return null;
  return (
    <div className="flex h-dvh flex-col overflow-hidden" data-testid="app-shell">
      <Header />
      <main className="min-h-0 flex-1 overflow-hidden" data-testid="app-main">
        <DesktopFrame>
          <Page />
        </DesktopFrame>
      </main>
      <BottomNav />
      <UploadDialog />
      <EditLessonDialog />
      <ConfirmDialog />
      <BackupDialog />
      <ToastRegion />
    </div>
  );
}
