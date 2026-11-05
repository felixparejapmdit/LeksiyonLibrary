import { useEffect, useRef, useState } from 'react';
import { Download, Moon, RotateCcw, Sun, Upload } from 'lucide-react';
import { api } from '../api';
import { askReset, RestoreInput } from '../components/Header';
import { VerseImport } from '../components/VerseImport';
import { setState, setTheme, useStore } from '../store';

export function SettingsPage() {
  const theme = useStore((s) => s.theme);
  const lessons = useStore((s) => s.lessons.length);
  const verses = useStore((s) => s.verses);
  const restoreRef = useRef<HTMLInputElement>(null);
  const [ai, setAi] = useState<{ available: boolean; reachable: boolean; model: string; meaning: boolean } | null>(null);
  const lastBackup = useStore((s) => s.lastBackupAt);

  useEffect(() => {
    let alive = true;
    api.aiStatus().then((s) => alive && setAi(s)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="scroll-stable h-full" data-testid="settings-page">
      <div className="mx-auto max-w-2xl space-y-3 p-3 lg:p-4">
        <h1 className="m-0 text-lg font-semibold">Settings</h1>
        <section className="rounded-lg border border-line bg-panel p-3">
          <h2 className="m-0 mb-2 text-[14px] font-semibold">Appearance</h2>
          <div className="flex gap-1.5" role="group" aria-label="Theme">
            <button className={`btn ${theme === 'dark' ? 'border-accent2!' : ''}`} aria-pressed={theme === 'dark'} data-testid="settings-dark" onClick={() => setTheme('dark')}>
              <Moon size={14} /> Dark
            </button>
            <button className={`btn ${theme === 'light' ? 'border-accent2!' : ''}`} aria-pressed={theme === 'light'} data-testid="settings-light" onClick={() => setTheme('light')}>
              <Sun size={14} /> Light
            </button>
          </div>
        </section>
        <section className="rounded-lg border border-line bg-panel p-3">
          <h2 className="m-0 mb-1 text-[14px] font-semibold">Your data</h2>
          <p className="m-0 mb-2 text-[13px] text-muted" data-testid="settings-stats">
            {lessons} {lessons === 1 ? 'lesson' : 'lessons'}, {verses.length} verse {verses.length === 1 ? 'record' : 'records'}, {verses.filter((v) => v.status === 'verified').length} verified.
          </p>
          <p className="m-0 mb-2 text-[13px] text-muted" data-testid="settings-encryption">
            Your lessons are encrypted on this PC and can only be opened by this user account on this computer. If this computer fails, an encrypted backup is the only way to get them back.
          </p>
          <p className="m-0 mb-2 text-[13px] text-muted" data-testid="settings-last-backup">
            {lastBackup ? `Last backup: ${new Date(lastBackup).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.` : 'No backup made yet.'}
          </p>
          <RestoreInput inputRef={restoreRef} />
          <div className="flex flex-wrap gap-1.5">
            <button className="btn" data-testid="settings-backup" onClick={() => setState({ backupOpen: true })}><Download size={14} /> Download encrypted backup</button>
            <button className="btn" data-testid="settings-restore" onClick={() => restoreRef.current?.click()}><Upload size={14} /> Restore</button>
            <button className="btn" data-testid="settings-reset" onClick={askReset}><RotateCcw size={14} /> Reset vault</button>
          </div>
        </section>
        <VerseImport />
        <section className="rounded-lg border border-line bg-panel p-3">
          <h2 className="m-0 mb-1 text-[14px] font-semibold">AI assistant</h2>
          <p className="m-0 min-h-5 text-[13px] text-muted" data-testid="settings-ai">
            {ai === null ? 'Checking' : ai.available ? `Connected to local model ${ai.model}.` : ai.reachable ? `Local AI is running, but model ${ai.model} is not installed.` : 'Local AI is offline. Verse matching still works without it.'}
          </p>
          {ai?.reachable && <p className="m-0 mt-1 text-[13px] text-muted" data-testid="settings-meaning">{ai.meaning ? 'Search by meaning is on.' : 'Search by meaning needs its model. Run: ollama pull bge-m3'}</p>}
        </section>
      </div>
    </div>
  );
}
