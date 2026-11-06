import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, FileSpreadsheet, Loader2, Moon, RefreshCw, RotateCcw, Sun, Upload, X } from 'lucide-react';
import { api, type AiStatus, type ModelPull } from '../api';
import { askReset, RestoreInput } from '../components/Header';
import { errorText, navigate, setState, setTheme, toast, useStore } from '../store';

/** Download sizes of the app's own models, as Ollama's library lists them. */
const SIZE_GB: Record<string, number> = { 'llama3.2:3b': 2.0, 'bge-m3': 1.2 };

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;

function PullProgress({ pull }: { pull: ModelPull }) {
  const share = pull.total > 0 ? pull.completed / pull.total : 0;
  return (
    <div className="mt-2" data-testid="ai-install-progress">
      <p className="m-0 text-xs text-muted" data-testid="ai-install-status">
        {pull.steps > 1 ? `${pull.step} of ${pull.steps}: ` : ''}
        {pull.status} {pull.model}
        {pull.total > 0 ? ` · ${gigabytes(pull.completed)} of ${gigabytes(pull.total)} (${Math.floor(share * 100)}%)` : ''}
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-raised" role="progressbar" aria-valuenow={Math.floor(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Downloading ${pull.model}`}>
        <div className="h-full origin-left bg-accent2" style={{ transform: `scaleX(${share})`, transition: 'transform 300ms linear' }} />
      </div>
    </div>
  );
}

/**
 * The local AI. Its model is installed from here: Ollama downloads and installs it in one step.
 * The model that writes notes, and the one behind search by meaning, are installed together.
 */
function AiCard() {
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [pull, setPull] = useState<ModelPull | null>(null);
  const [checking, setChecking] = useState(false);
  const installing = !!pull && !pull.done;

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const s = await api.aiStatus();
      setAi(s);
      setPull(s.pull);
    } catch {
      /* the card keeps what it showed */
    }
    setChecking(false);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // While a download runs, its progress is read every second; at the end the status is read again.
  useEffect(() => {
    if (!installing) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const { pull: next } = await api.aiInstallProgress();
        if (!alive) return;
        setPull(next);
        if (next?.done) {
          clearInterval(timer);
          if (next.error) toast(next.error, 'error');
          else toast('The AI model is installed');
          void check();
        }
      } catch {
        /* tried again on the next tick */
      }
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [installing, check]);

  const install = async () => {
    try {
      setPull((await api.aiInstall()).pull);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const ready = !!ai && ai.available && ai.meaning;
  const missing = ai ? [...(ai.available ? [] : [ai.model]), ...(ai.meaning ? [] : [ai.embed_model])] : [];
  return (
    <section className="rounded-lg border border-line bg-panel p-3" data-testid="settings-ai-card">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 mb-1 text-[14px] font-semibold">AI assistant</h2>
          <p className="m-0 min-h-5 text-[13px] text-muted" data-testid="settings-ai">
            {ai === null ? 'Checking' : ai.available ? `Connected to local model ${ai.model}.` : ai.reachable ? `Local AI is running, but model ${ai.model} is not installed.` : 'Local AI is offline. Verse matching still works without it.'}
          </p>
          {ai?.reachable && <p className="m-0 mt-1 text-[13px] text-muted" data-testid="settings-meaning">{ai.meaning ? 'Search by meaning is on.' : 'Search by meaning needs its model too. It is installed with the same button.'}</p>}
          {ai && !ai.reachable && (
            <p className="m-0 mt-1 text-[13px] text-muted" data-testid="settings-ollama-missing">
              The AI runs in Ollama, a free app for this computer. Install Ollama and start it, then check again. Its model can then be installed here.
            </p>
          )}
        </div>
        {/* On the right: one button does the download and the install. */}
        <div className="flex flex-none flex-wrap items-center gap-1.5">
          {ai && !ai.reachable && (
            <>
              <a className="btn" data-testid="settings-get-ollama" href="https://ollama.com/download" target="_blank" rel="noreferrer noopener">
                <ExternalLink size={14} /> Get Ollama
              </a>
              <button className="btn" data-testid="settings-ai-recheck" disabled={checking} onClick={check}>
                {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check again
              </button>
            </>
          )}
          {ai?.reachable && ready && (
            <span className="flex items-center gap-1 text-[13px] text-ok" data-testid="ai-installed"><CheckCircle2 size={14} /> Installed</span>
          )}
          {ai?.reachable && !ready && !installing && (
            <button className="btn btn-primary" data-testid="ai-install" title={`Downloads and installs ${missing.join(' and ')} in Ollama`} onClick={install}>
              <Download size={14} /> Download and install
            </button>
          )}
          {installing && (
            <button className="btn" data-testid="ai-install-cancel" onClick={async () => setPull((await api.aiCancelInstall()).pull)}>
              <X size={14} /> Cancel
            </button>
          )}
        </div>
      </div>
      {installing && pull && <PullProgress pull={pull} />}
      {ai?.reachable && !ready && !installing && (
        <p className="m-0 mt-2 text-xs text-muted" data-testid="ai-install-note">
          {missing.join(' and ')} {missing.length === 1 ? 'is' : 'are'} downloaded by Ollama from ollama.com{missing.every((m) => SIZE_GB[m]) ? `, about ${missing.reduce((n, m) => n + SIZE_GB[m], 0).toFixed(1)} GB` : ''}. Nothing from your vault is sent. You can keep working while it downloads.
        </p>
      )}
      {pull?.done && pull.error && <p className="m-0 mt-2 text-xs text-warn" data-testid="ai-install-error">{pull.error}</p>}
    </section>
  );
}

export function SettingsPage() {
  const theme = useStore((s) => s.theme);
  const lessons = useStore((s) => s.lessons.length);
  const verses = useStore((s) => s.verses);
  const restoreRef = useRef<HTMLInputElement>(null);
  const lastBackup = useStore((s) => s.lastBackupAt);

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
        <section className="rounded-lg border border-line bg-panel p-3" data-testid="settings-import">
          <h2 className="m-0 mb-1 text-[14px] font-semibold">Importing verses</h2>
          <p className="m-0 mb-2 text-[13px] text-muted">Verses from Excel files are imported on their own page, under Pastoral Visits. They go to the Verse Library.</p>
          <button className="btn" data-testid="settings-open-import" onClick={() => navigate('/import')}><FileSpreadsheet size={14} /> Open Import Verses</button>
        </section>
        <AiCard />
      </div>
    </div>
  );
}
