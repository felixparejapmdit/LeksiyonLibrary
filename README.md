# Lesson Vault

Lesson library and Tagalog-English verse collection. Rust (Axum) + SQLite backend, React + Vite + Tailwind PWA frontend. Runs locally on Windows or Mac. Lessons are encrypted on disk and can only be opened by the user account that created them, on that computer.

## Run

From this folder, in a terminal:

    npm start

Then open http://127.0.0.1:47319. It goes straight to your dashboard; there is no sign-in. Press **Ctrl+C** in that terminal to stop.

`npm start` builds whatever has changed, then runs the app in the foreground. The first build takes a few minutes; later starts take seconds. It needs Node.js and Rust installed.

On a Mac, also install Apple's command line tools first (`xcode-select --install`). The first start asks permission to use the Keychain, where the vault's key is protected. Choose **Always Allow**. Because the app is not code-signed, macOS may ask again after a rebuild. Mac support has not yet been tested on a real Mac.

To work on the frontend with hot reload:

    npm run dev

Then open http://127.0.0.1:47320. Both commands use the same encrypted data, `backend/data`, and the startup message prints the folder in use.

Because there is no sign-in, the app only accepts connections from this computer, and refuses requests that come from other websites. Anyone using this computer can open your vault. To host it for others, sign-in would have to be added back first.

If the port is taken, the server stops with an error instead of moving to another port. That usually means Lesson Vault is already running in another terminal.

| Variable | Default | Purpose |
|---|---|---|
| `LV_PORT` | 47319 | App port |
| `LV_DATA` | `data` | Database and PDFs (relative to `backend/`) |
| `LV_OLLAMA_URL` | http://127.0.0.1:11434 | Local AI service (optional) |
| `LV_OLLAMA_MODEL` | llama3.2:3b | Model for AI notes |

## Your data

Nothing in this repository contains lesson data. A fresh clone starts with an empty vault.

Everything saved by the app is encrypted with AES-256-GCM. The key is protected by the operating system (DPAPI on Windows, the Keychain on a Mac) and tied to this account on this computer, so copying `backend/data` elsewhere yields nothing readable. There is no password to remember for daily use.

**If this computer fails, or its system is reinstalled, your vault cannot be opened.** Download an encrypted backup regularly (Backup, then choose a passphrase) and keep it off this PC. A forgotten passphrase cannot be recovered. Do not delete `backend/data/vault.key`.

To move to another computer, including from Windows to a Mac, make an encrypted backup and use Restore there. Restore replaces whatever is in that vault.

Files you export, such as a downloaded PDF or a copied lecture, are not encrypted.

## Lecture Maker

Write one objective per line and choose 3, 4 or 5 verses per objective. Verses come only from your library, shown exactly as stored. If fewer match, the app says so instead of adding unrelated verses.

With the local AI running, each verse also shows who is speaking, a **chapter context** and a **book context**. These are the model's reading, not scripture, and can be wrong, so they are labelled until you review or correct them. Each chapter and book context is written once and shared by all its verses, so a correction applies everywhere and later searches are quicker. Your wording is kept, later AI runs leave it alone, and it never changes the verse.

Saved lectures keep each verse under its objective. From the workspace you can copy, print or save as PDF, download a Word file, or present full screen, one reference at a time in both languages (arrow keys to move, Esc to leave). Word files and printouts are not encrypted.

## Other tools

- **Review Verses:** steps through unverified verses beside the page they came from. Verifying locks a verse permanently.
- **Find by meaning:** finds verses related to a question even when they share no words, in Tagalog or English. Available in the Lecture Maker, Bibles Library and Search. It suggests from your library only, and falls back to matching words if the model is off.
- **Teaching History:** records when and where you gave each lesson, and warns before you repeat one.
- **Select a folder:** when uploading, adds every PDF in a folder, skips other files, and flags lessons to check.
- **Backup reminder:** appears if you have lessons and no backup in the last 14 days.

## Local AI (optional)

    ollama pull llama3.2:3b
    ollama pull bge-m3

`llama3.2:3b` writes notes and context. `bge-m3` powers Find by meaning. Everything else works without them. If you change `LV_OLLAMA_EMBED_MODEL`, the similarity threshold in `backend/src/semantic.rs` needs measuring again.

## Test

    npm test

This builds everything, then runs the Rust unit tests and the Playwright suite. Install the test tools once first: `cd e2e && npm ci && npx playwright install chromium`.

Tests use their own ports (47329, 47321) and a throwaway database. See `project_plan_deep_review.md`, Part 3, for results and known limits.

The real sample lessons are sensitive, so they and any text from them are kept out of this repository. Set `LV_SAMPLES` to a private folder with `samples.json` and `fixtures/` (default: `../LeksiyonLibrary-private`). Without it, the two Rust tests that use samples skip themselves, and the Playwright suite cannot start.

Test traces and screenshots are off because they would show lesson pages. Set `LV_DEBUG_ARTIFACTS=1` to turn them on. A failed test also writes a text snapshot of the page, so delete `e2e/test-results` after a failed run.
