# Deep Review & Project Plan: Leksiyon Library & Tagalog-English Bibles System

## Part 1: Deep Review of the Current System & Proposed AI Features

### 1. Context & Standard Evaluation

* **Domain:** Professional / Religious Educational Tool (Lesson Vault & Scripture Library)

* **Target Audience:** Ministers, Bible study conductors, and teachers preparing sermons or lessons in Tagalog and English.

* **Proficiency Level (Current Prototype):** Good (Strong foundational structure, clean UI layout, effective PDF viewing and tag indexing).

### 2. Analysis of Existing Features (Based on Screenshots & Video Hierarchy)

* **Sidebar Hierarchy & Ingestion Flow:** The system correctly mirrors pastoral and midweek categories, where the primary ingestion point is **PDF Upload** to populate the lesson library before initiating deeper study or AI assistance.

* **Dual-Pane Layout:** Splitting the interface between an archival navigation tree and an integrated PDF/Outline Viewer provides smooth workflow context.

### 3. Evaluation of New Proposed Features & Tech Adjustments

* **Automated Tagalog Verse Compilation & Library:** Centralizes parsed scriptures into a structured repository for rapid referencing during lecture preparation.

* **AI-Assisted Lesson / Lecture Maker:** Allows users to input specific issues and objectives after uploading reference PDFs so the AI can suggest matching scriptures.

* **Strict Guardrail:** **Zero-Modification Policy on Official Translations.** The AI acts purely as a retriever and suggester; official Tagalog and English Bible texts remain immutable.

* **Technology & Mobile Readiness:** Upgrading the backend to **Rust** for blazing-fast, secure API performance, alongside **PWA readiness**, full responsiveness, and a modern **mobile/tablet bottom navigation bar**.

---

## Part 2: 6 Essential Documents Before Building with AI

### 1. PRD (Product Requirements Document)

* **Product Name:** Lesson Vault & Translated Bibles Library (Tagalog-English) with AI Lecture Assistant.

* **Core Objectives:**

  * Provide a centralized repository for midweek, weekend, and pastoral visit lessons via seamless PDF ingestion.

  * Automate the compilation and tagging of translated Tagalog-English Bible verses into a searchable library.

  * Introduce an AI-assisted lesson planner where users list issues and objectives after lesson upload to receive strict, non-modified official verse recommendations.

  * Deliver a Progressive Web App (PWA) experience with cross-device responsiveness and a modern mobile bottom navigation bar.

* **Key User Stories:**

  * *As a minister*, I want to upload lesson PDFs first, and then input my issue and objective so the AI can suggest matching official scripture texts without altering translations.

  * *As a teacher*, I want an automated compilation of Tagalog verses accessible instantly on my mobile or tablet device via a bottom navigation bar.

### 2. TDD (Technical Design Document)

* **Architecture:** Client-server web application (Single-Page Application frontend with a high-performance Rust backend API layer).

* **Tech Stack:**

  * *Frontend:* React.js / Vite with Tailwind CSS (Modern minimalist theme tailored for deep textual study and dark/light modes).

  * *Backend:* **Rust** (using Axum or Actix-web framework) for robust document parsing, API routing, and AI orchestration.

  * *Database:* PostgreSQL with `pgvector` for semantic scripture and lesson indexing.

  * *PWA & Mobile:* Service Workers, Web Manifest, responsive CSS grid/flexbox layout with a fixed mobile bottom navigation menu.

### 3. App Flow

1. **Authentication & Dashboard:** User logs in and lands on the main responsive dashboard.

2. **PDF Ingestion & Library Organization:** User uploads official lesson PDFs (`Upload PDF` action prominent in sidebar/header). The system parses and categorizes files into Midweek, Weekend, or Pastoral Visits.

3. **AI Lecture Maker Workflow:**

   * User opens a lesson or starts a new lecture creator.

   * User inputs **Issue / Topic** and **Objective**.

   * AI queries the vector database of official scriptures and existing lesson chunks.

   * AI suggests relevant official Bible verses in a read-only recommendation panel.

   * User selects desired verses to compile into their active workspace.

4. **Cross-Device Navigation (PWA / Mobile):** On mobile or tablet view, a modern **bottom menu bar** provides instant switching between Vault, Bibles Library, Search, and Profile/Settings.

### 4. Design Brief (Modern UI/UX)

* **Aesthetic & Vibe:** Calm, distraction-free, academic yet spiritual. Minimalist dark-first design (`#0b0f19` slate/charcoal background) with clean whitespace and crisp typography for intensive text reading.

* **Color Palette:** 

  * Backgrounds: Deep slate (`#0f172a`, `#1e293b`)

  * Accents: Royal Indigo / Sacred Blue (`#6366f1`, `#3b82f6`) for active tags and primary actions.

  * Text: High contrast neutral light (`#f8fafc`) for readability.

* **Layout & Mobile UX:** Desktop utilizes a 3-column split (Sidebar tree, main list, PDF/Outline viewer). Mobile/Tablet collapses into single-column views with a sleek, floating or anchored **bottom navigation bar** for thumb-friendly ergonomics.

### 5. Backend Schema (Rust / PostgreSQL)

* **`users` Table:** `id` (UUID), `email` (VARCHAR), `password_hash` (VARCHAR), `created_at` (TIMESTAMPTZ)

* **`lessons` Table:** `id` (UUID), `user_id` (UUID), `title` (VARCHAR), `category` (VARCHAR), `file_path` (VARCHAR), `content` (TEXT), `created_at` (TIMESTAMPTZ)

* **`bible_verses` Table:** `id` (UUID), `version` (VARCHAR - e.g., Tagalog/English), `book` (VARCHAR), `chapter` (INT), `verse_number` (INT), `text` (TEXT - Read-only official text)

* **`lesson_verses` Table:** `id` (UUID), `lesson_id` (UUID), `verse_id` (UUID)

* **`ai_prompts_log` Table:** `id` (UUID), `user_id` (UUID), `input_issue` (TEXT), `input_objective` (TEXT), `suggested_verse_ids` (JSONB), `timestamp` (TIMESTAMPTZ)

### 6. Engineering Plan

* **Phase 1: Rust Backend & Database Setup (Weeks 1-2)**

  * Initialize Rust workspace (Axum/Tokio), configure PostgreSQL + pgvector, and set up database migrations.

* **Phase 2: Frontend Layout & PDF Ingestion Pipeline (Weeks 3-4)**

  * Build React + Tailwind frontend, implement PDF upload handling in Rust backend, and establish the hierarchical sidebar tree.

* **Phase 3: Automated Verse Compilation & Library (Week 5)**

  * Implement automatic parsing and indexing of cited Tagalog/English verses into a centralized searchable library.

* **Phase 4: AI Lecture Maker & Guardrails (Weeks 6-7)**

  * Build issue/objective input module, integrate RAG retrieval, and enforce strict system guardrails ensuring official translations are untouched.

* **Phase 5: PWA, Responsive Polish & Bottom Navigation (Week 8)**

  * Implement Service Workers, Web Manifest, responsive mobile/tablet layout optimization, and the modern mobile bottom navigation menu.
---

## Part 3: Deep Review & Study (REA, Build and Test Findings), November 2026

This part reviews Parts 1 and 2 against evidence: the two prototype recordings, the two sample PDFs, the working application built from this plan, and its test results. Parts 1 and 2 above are unchanged.

### 1. Verdict

The product direction is sound, but the plan had five gaps that would have broken the product in real use. All five were found by working with the real samples, not by reading the plan.

| # | Gap in the plan | Evidence | What was built |
|---|---|---|---|
| 1 | Assumes PDFs contain text. | Both samples are image-only scans: 12 pages, 0 characters of text. A normal PDF parser extracts nothing. | Local OCR (Tagalog + English) in a Web Worker. Digital PDFs use their text layer. |
| 2 | "Immutable official text" has no source. | No Bible data was supplied. Verse text reaches the app only through OCR, which makes errors. OCR output cannot be treated as official. | Every verse starts **Unverified**. A person corrects and verifies it; then database triggers lock it permanently. The original extraction is kept permanently. |
| 3 | Treats a verse as one text per version. | A Tagalog lesson can cite an English-language version but print Tagalog wording. Text, language and cited version are three separate facts. | The library stores language and version separately and groups by a canonical reference, so Tagalog and English sit side by side. |
| 4 | Assumes references parse cleanly. | Series numerals are the danger: a "II" read as "I" is a wrong book, not a typo. | See section 3. |
| 5 | Phase estimates ignore document handling. | OCR, citation parsing and verification were the hardest part of the system; Phase 3 gives them one week. | Replan with this work as its own phase. |

### 2. Evidence method

Findings are labelled by how they are known.

**REA (shipped build and running app)**

- *Observed, runtime:* `capture_browser_scenario` (`ev_8c148145…c89aea`) drove sign-in, Bibles, Lecture and Vault. All 44 recorded events were on loopback, with no page errors. The one console error is the expected 401 from the signed-out session check. The capture ended with one status request still open, so later activity is unknown.
- *Derived, static:* `analyze_javascript_application` on an earlier build of `frontend/dist` (`ev_ae64a989…5d1e1d`) parsed 13 JavaScript files with 0 parse failures.
- *Observed:* `inspect_pe_resources` on an earlier build of the backend binary (`ev_4bc0f199…ed99b`): PE32+, no embedded resources, so no icon is set on the executable.

**REA limits.** REA suits shipped artifacts and running apps, not the Markdown plan or MP4 recordings, so those were studied directly. Its static semantic analysis is **partial**: it ran out of heap on the large bundles, and a focused pass on the main app bundle hit its 5-minute limit. Those unknowns are not evidence that anything is absent. The MCP server was also unavailable for the first part of this work.

**Not from REA:** frames from both recordings (features and defects below), page images and OCR of both samples, and the test results in section 6.

### 3. Key study: reading series numerals

| Input to OCR | Result on the sample references |
|---|---|
| Resampled render at 2.78x, 3.5x, 4.17x, 5.5x | Kept misreading the series numeral "II" as "I", "1" or "[I". Higher resolution did not reliably help. |
| The scanner's original embedded pixels | **20 of 20 references correct** in this test, and about 30 ms of drawing instead of about 190 ms of main-thread work. |

This is a result on two samples, not a guarantee. So there are three layers: original pixels; cross-checking the Tagalog and English editions of a lesson, which flags any correction for review; and human correction before verification.

### 4. Prototype review (from the recordings)

Kept: the three-pane layout, tabs with live counts, filter chips, keyword highlight, verse filtering, Backup/Restore/Reset, resizable panes.

Defects seen and addressed:

- Placeholder data shown as real ("Day/Day: Month 00/00, 0000", "By: First Name Last Name"). Unknown values are now omitted, and lesson details can be edited.
- "1 items" grammar.
- The prototype's own source was not found in `D:\PROJECTS`, Desktop or Documents, so this is a new build informed by the recordings, not its code.

### 5. Decisions that differ from the plan

| Plan | Built | Why | Cost |
|---|---|---|---|
| PostgreSQL + pgvector | SQLite + FTS5 (project owner's choice) | No server to install; single-file database. | Keyword matching, not semantic. An objective will not find a verse that means the same thing unless the words match. **This is the largest functional gap against the plan.** |
| Rust does document parsing | Browser does PDF reading and OCR; Rust parses the resulting text | Keeps OCR off the server and bundled offline. | Uploads depend on the browser staying open. |
| AI retrieves verses (RAG) | Retrieval is plain ranking; the local model only writes short notes | The model never handles verse text that is shown. Strongest form of the guardrail. | Notes took about 2 minutes on this CPU; they load in the background. |
| `lesson_verses` only | Added `lectures`, `lecture_verses`, `folders`, `sessions` | Needed by the workspace, folders and sign-in. | None. |

### 6. Test results

- **Rust:** 17 of 17 unit tests pass, including both real samples.
- **Playwright:** 87 of 87 pass, in **two consecutive full runs** against the release build. Every control seen was clicked by a test.
- **Slowest interaction:** 88 ms (budget 200 ms). **Layout shift:** 0 on every measured flow. **Longest main-thread task:** 177 ms, with a 400-lesson library (budget 200 ms). These figures are from the last run.
- **Flicker probes:** every animation frame was checked during zoom, rotate, page flips, lesson switching and pane drags: no blank PDF canvas and no vanished region.

**Correction after release:** the project owner then reported the PDF pane shaking, which all of the above had missed. Headless Chromium hides scrollbars, so the flicker probes could not see a fit-to-width loop: the scrollbar appeared, the page shrank from 528 to 513 px, the scrollbar disappeared, and this repeated every frame at window heights of about 856-874 px. It was reproduced with real scrollbars, fixed by reserving the scrollbar's space, and now has a regression test that sweeps window sizes. The suite is now **89 of 89** (one full run after the fix; slowest interaction 128 ms, longest task 166 ms). A passing suite remains evidence, not proof of smoothness; hands-on use still finds things tests miss.

Bugs the tests and visual review caught and that are now fixed: wrong book from OCR; dead-end navigation on desktop; dialogs clipped by a containment ancestor; hidden controls showing on phones; crushed titles on phones; zero-width lists on small tablets; a false "AI offline" status caused by Ollama's 6.7-second cold start; pronouns counted as search matches; a pane-drag dead zone.

### 7. What "100% working" does not cover

These limits remain, and the tests cannot remove them:

- **Browsers and devices:** automated tests ran in headless Chromium only, using emulated phone and tablet sizes. Safari, Firefox and real devices are untested. "No lag or flicker" is measured on this PC, not guaranteed on a low-end phone.
- **OCR on other documents:** accuracy was measured on 2 samples of one layout. Other scan qualities and layouts may parse less well.
- **AI quality:** the automated tests use a stand-in model. The real model was checked once by hand and left verses byte-identical. Its notes can be theologically wrong, so they are labelled "AI note, not scripture. Review before use". The guardrail stops quoting and altered verses, but it cannot detect every paraphrase in a note.
- **Deployment:** runs on localhost. Installing on a phone needs HTTPS hosting, which is not set up. Offline mode covers the app shell only, by design: lesson data is not cached.

### 8. Decisions for the project owner

1. **Copyright and confidentiality.** Lessons and modern Bible versions (ESV, GNT, NIRV, AMP and others) are copyrighted, and teacher's guides may be restricted. The app stays local today. Get guidance before hosting it for others.
2. **Terminology.** "Official translation" needs a definition. The Tagalog wording in the samples renders English-language versions. The library currently means "as printed in your lesson", not a published Bible.
3. **Semantic search.** Decide whether to add local embeddings. It is the most valuable next step for the Lecture Maker, and it can stay on SQLite.
4. **Next steps, in order:** a backup routine off the USB drive; a review queue for unverified verses; semantic search; HTTPS hosting; testing on real phones and tablets.

### 9. Infrastructure incident

During final testing the PC slept (10:49 PM to 12:44 AM). On wake, Windows reported NTFS corruption on `D:`, the USB-attached Seagate drive holding this project: "Full Repair Needed". The `frontend` folder became unlistable, `e2e\package.json` became unreadable, and `VaultPage.tsx` read back as NUL bytes.

The project was recovered to `C:\Users\felix\Projects-rescue\LeksiyonLibrary`: readable files by direct read, the unreadable manifest and `VaultPage.tsx` reconstructed by hand from the session's record of them. It was then fully rebuilt and retested there. **This copy on `C:` is the authoritative one.** The project is not under version control, so there is no history to fall back on.

### 10. Review after the incident (4 November 2026)

**Recovery checks.** Both stored PDFs and all 20 verse texts match their recorded SHA-256 hashes. The database passes its integrity check. No project source file contains NUL bytes or invalid UTF-8. Both `package.json` files agree with their lockfiles. Reconstructed files can only be checked this way and by the tests; they cannot be compared with the originals, because `D:` still returns I/O errors.

**Found and fixed:**

| Problem | Evidence | Fix |
|---|---|---|
| The app only found its data when started from `backend/`. `start.ps1` hid this. | Started from another folder, it created a new empty database there and returned 404 for `/`. | Relative paths now resolve from the backend folder above the executable. `npm start` and `npm run dev` run from the project root, in the foreground. |
| The hidden process had no clean way to stop. | The real database file was 4 KB, with all of its data still in a 733 KB write-ahead log. | Ctrl+C or closing the terminal now shuts down cleanly and completes the log. Startup also completes anything a killed run left behind. |
| A second copy opened the database before finding the port was taken. | Order of operations in `main.rs`. | The port is claimed first. |
| A power loss could lose recent saves. | `synchronous = NORMAL`, and PDFs written without flushing to disk. | `synchronous = FULL`, and PDFs are flushed before the save is reported as done. |

**Test results after the fixes:** Rust 20 of 20 (3 new), Playwright 89 of 89 in one full run. Slowest interaction 96 ms, longest task 167 ms, layout shift 0. `npm start` and `npm run dev` were each also run against a copy of the real data from an unrelated folder, viewed in a browser, and stopped with a real Ctrl+C.

**Still open:**

- AI notes are unavailable on this PC: Ollama does not have the configured model, `llama3.2:3b`. Verse matching still works.
- The project is still not under version control.
- There is still no routine backup off this computer.
- `D:` still needs a repair, or the drive replaced. Treat anything still on it as unreliable.

### 11. Single-user changes and context (4 November 2026)

**Sign-in removed**, at the project owner's request. The app opens directly on the dashboard, and all existing data stays with the original account's records. The sign-in cookie was also the app's defence against other websites sending requests to it, so it was replaced: the API refuses any request that does not come from the app's own pages, and the server refuses to bind to anything but this computer. Anyone using this computer can now open the vault. Hosting it for others requires adding sign-in back.

**Lecture Maker.** Each objective line gets its own group of 3, 4 or 5 verses. Retrieval is still keyword matching, so a group can be short; the app says so rather than adding unrelated verses. Each verse also shows who is speaking and its context.

- **The speaker and context are the AI's reading, not facts from the library.** They are labelled for review, and they can be wrong. Quotes, altered text and other verse citations are rejected, but a confident wrong statement cannot be detected automatically.
- They are saved in their own table, separate from `verses`, so they can never alter scripture text. They appear in the workspace, Copy and Print, and are included in backups.

**Issue and objectives.** The parser already read these from the scans; the app did not show them. Each lesson now has an Issue and Objectives panel ("Isyu at Mga Layunin" for Tagalog), and both can be edited, because OCR can misread them. Edits are searchable. The Lecture Maker can load them from a lesson.

**PDF viewer bug fixed.** After switching lessons, the viewer could keep showing the previous lesson's page. While the new PDF loaded, the old one was rendered and cached under the new lesson's key. The tests missed it because they checked which lesson was selected, not the pixels on screen. A regression test now compares the pixels with a slow-loading PDF.

**Repository.** The code is at `github.com/felixparejapmdit/LeksiyonLibrary`, which is public. The database, lesson PDFs, recordings and lesson-text test fixtures are excluded, in line with section 8, item 1.

**Stale sign-in page fixed.** With the server stopped, the service worker served the offline copy it saved before sign-in was removed, so the old sign-in page reappeared. The offline copy now refreshes on every successful load, and older caches are deleted.

**Test results:** Rust 29 of 29, Playwright 103 of 103 in one full run, with no other work running. Earlier full runs that overlapped builds or downloads failed performance budgets, which clean runs did not reproduce: these budgets are sensitive to load on this PC. Tests use a stand-in model.

**Real model check,** `llama3.2:3b` on this CPU, one objective from a sample lesson: 45 seconds, verses unchanged. It named the expected speakers, but its context for one verse was wrong about who was being addressed, and one of the three notes was blank. This was one check on one objective, not a measure of accuracy. Treat all of this as a draft for review.

### 12. Encryption (5 November 2026)

Lessons are sensitive, so everything is encrypted at rest and nothing from them belongs in the repository.

| What | How | Who can read it |
|---|---|---|
| Database | AES-256-GCM. SQLite runs in memory and saves a sealed snapshot, so no plaintext database, journal or temp file reaches the disk. | This Windows account on this PC |
| Lesson PDFs | AES-256-GCM, bound to their lesson id | This Windows account on this PC |
| The key | Random 256-bit, wrapped by Windows DPAPI | This Windows account on this PC |
| Backups | AES-256-GCM, key from a passphrase with Argon2id | Anyone with the file and the passphrase |

SQLCipher was the usual choice but needs OpenSSL build tools. A sealed snapshot needs none, and detects tampering, but rewrites the whole database on every save. That was fine at 400 lessons in the tests; it may need revisiting for a very large library.

**Limits:**

- **Losing the key means losing the data.** A failed PC, a reinstalled Windows or a deleted account or `vault.key` makes the vault unreadable. Passphrase backups are the only recovery, and a forgotten passphrase cannot be recovered.
- **It protects data at rest,** such as a copied folder, a stolen drive read elsewhere, or a repository. Anything running as this Windows account while it is signed in can use the key, and there is no app password.
- **Files the user exports are plain.** Downloading a PDF or copying a lecture creates an ordinary file or clipboard text.
- **Removing old plaintext is best effort.** On an SSD, overwritten blocks can survive until reused. BitLocker covers this, and the local AI model only runs on this PC.

**Repository.** Real lesson text in test code was removed, and sample-based tests now read it from a private folder (`LV_SAMPLES`). Those tests cannot run from a fresh clone.

**Verified on the real vault:** counts, verse hashes and PDF bytes were identical after migration and after a restart. A scan of every file in the data folder found no readable lesson text. A passphrase backup rebuilt everything in a new empty vault, and a wrong passphrase was refused. Rust 37 of 37, Playwright 108 of 108.

### 13. Features added after review (5 November 2026)

Added at the project owner's choice: a verse review queue, editable AI context, objective groups in saved lectures, Word export, presentation mode, backup reminders, search by meaning, teaching history and folder import.

**Search by meaning replaces the largest gap named in section 5.** It uses local embeddings stored in the encrypted database. The first model tried, `paraphrase-multilingual`, worked in English but not Tagalog: a question about cooking scored as high as a real question, so it would have shown unrelated verses as related. `bge-m3` separated them in both languages on the sample verses: the best match for related questions scored at least 0.60, and unrelated questions at most 0.41. The threshold is 0.50. This was 13 questions on a 20-verse library, so a larger library may need it revisited. Among themed verses, lower-ranked results can be weakly related.

**Bug found while testing:** narrowing the window rebuilt the page and lost an unsaved lecture. Printing could trigger the same thing. The page now keeps its state at every width.

**Limits:** the Word file and any printout are plain files. The PDF route is the browser's print dialog, not a generated file. Presentation mode has been tested in a browser, not on a projector.

### 14. Mac support, chapter and book context (5 November 2026)

**Chapter and book context** replace the AI's verse-level context, at the project owner's request. They are stored per chapter and per book, not per verse: one book reads the same everywhere, a correction reaches every verse it covers, and each is written once. The model still writes a speaker for each verse. Unreviewed verse-level text from the AI was cleared; anything the user reviewed remains as a verse note.

**Accuracy, measured on the real model (`llama3.2:3b`).** Asking about several books and chapters at once blended them: one chapter was described by another book's themes, and speakers came back as book names. Asking about each one at a time was clearly better, and named all four test speakers correctly, so that is how it works now. `qwen2.5-coder:3b` was worse. The model is small and still makes mistakes: on a well-known chapter, it reversed part of what happens. **Treat all of this as a draft for review.** A larger model may do better, but needs disk space this PC does not have.

**Test results:** Rust 50 of 50, Playwright 121 of 121 in one full run. Tests use a stand-in model.

**Mac support** wraps the vault key with a master key in the Mac Keychain, as DPAPI does on Windows. The rest of the code was already cross-platform. **It has not been run on a Mac.** It was written on Windows, where only the Mac-specific key code could be type-checked against a Mac target, not built or run. Safari is also untested; Chrome is the tested browser.

### 15. Verse import, three contexts in two languages, a paged library (5 November 2026)

**Import.** Settings takes an Excel file or a Google Sheet, previews what will happen, and saves nothing until confirmed. The existing `verses.version` column holds the translation; a new `import_source` column records the file and row. Language is detected per row from common words, because the sample sheet files Tagalog text under codes such as MSG and AMP. Measured on a real 998-row sheet: 882 new verses, 111 repeated rows skipped, 5 rows left for the owner to fix because a book had no number, 8 flagged because the printed number and the verse disagree. The Excel and Google routes gave identical results. A scan of the vault afterwards found no readable verse text.

**Google Sheets is the one exception to local-only.** It works only for a sheet shared as Anyone with the link, which anyone holding the link can read. Signing in to Google would avoid that, but needs a registered app and stored tokens, so it was not added. Excel remains the private route, and the screen says so.

**Context.** Details are folded until opened, and still print. A historical and political context was added per book. Tagalog wording is stored separately, translated only when first read, and reviewed separately, so a translation of reviewed English stays labelled as AI.

**Accuracy, measured on the real model (`llama3.2:3b`).** It is often wrong on exactly what this feature asks of it. It placed Colossians under Tiberius and described II Samuel's period with Solomon and a divided kingdom. Its Tagalog rendered "letter" as "tulay" (bridge). Everything stays labelled until reviewed, and a stronger model or owner-written text would be needed for this to be relied on.

**Library.** The Bibles Library pages by reference, with book and translation filters. Keeping every verse in memory was kept, since all of it loads in about 70 ms, and search text, sort order and page position are cached in memory only, so nothing readable reaches the disk or the browser's cache.

**Test results:** Rust 79 of 79, Playwright 143 of 143 in one full run, with the new test file run again after one last small fix. Tests use made-up verses and a stand-in for both the model and Google.

### 16. Changes after the first real import (5 November 2026)

**Teaching history was removed at the project owner's request.** The page, the lesson buttons, the API and the table are gone. A backup that still holds records restores without them.

**The sidebar counts now agree.** Bibles Library counted references and Review Verses counted verses, so 680 sat beside 901. Both now count verses, and differ only by how many are verified.

**The Verse column now wins over a number stuck to the text.** This reverses the earlier rule of keeping the number and flagging the row, at the owner's instruction. A number with a space after it still gets flagged, because it may be part of the sentence ("3 days later"). Verses imported before this change are corrected once when the vault opens, unless the user has already changed the text. The original cell is kept unchanged.

**Rows left out are kept for fixing in the app.** They were only listed in the preview, so they were lost once it closed. They now stay in the encrypted vault and travel in backups, and a correction goes through the same checks as the sheet.
