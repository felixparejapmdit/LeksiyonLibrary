# Lesson Vault

Lesson library and Tagalog-English verse collection. Rust (Axum) + SQLite backend, React + Vite + Tailwind PWA frontend. Runs locally on Windows or Mac. Lessons are encrypted on disk and can only be opened by the user account that created them, on that computer.

## Run

From this folder, in a terminal:

    npm start

Then open http://127.0.0.1:47319. It goes straight to your dashboard; there is no sign-in. Press **Ctrl+C** in that terminal to stop.

`npm start` builds whatever has changed, then runs the app in the foreground. The first build takes a few minutes; later starts take seconds. It needs Node.js and Rust installed.

After updating the project, stop the running app with **Ctrl+C**, then run `npm start` again. Refreshing the browser loads the new interface but does not restart the backend; on Windows the running executable also stays locked until it stops.

On a Mac, also install Apple's command line tools first (`xcode-select --install`). The first start asks permission to use the Keychain, where the vault's key is protected. Choose **Always Allow**. Because the app is not code-signed, macOS may ask again after a rebuild. Mac support has not yet been tested on a real Mac.

To work on the frontend with hot reload:

    npm run dev

Then open http://127.0.0.1:47320. Both commands use the same encrypted data, `backend/data`, and the startup message prints the folder in use.

Because there is no sign-in, the app only accepts connections from this computer, and refuses requests that come from other websites. Anyone using this computer can open your vault. To host it for others, sign-in would have to be added back first.

If the port is taken, the server stops with an error instead of moving to another port. That usually means Lesson Vault is already running in another terminal.

| Variable | Default | Purpose |
|---|---|---|
| `LV_PORT` | 47319 | App port |
| `LV_DATA` | `data` | Database and lesson documents (relative to `backend/`) |
| `LV_OLLAMA_URL` | http://127.0.0.1:11434 | Local AI service (optional) |
| `LV_OLLAMA_MODEL` | llama3.2:3b | Model for AI notes, context and translation |

## Your data

Nothing in this repository contains lesson data. A fresh clone starts with an empty vault.

Everything saved by the app is encrypted with AES-256-GCM. The key is protected by the operating system (DPAPI on Windows, the Keychain on a Mac) and tied to this account on this computer, so copying `backend/data` elsewhere yields nothing readable. There is no password to remember for daily use.

**If this computer fails, or its system is reinstalled, your vault cannot be opened.** Download an encrypted backup regularly (Backup, then choose a passphrase) and keep it off this PC. A forgotten passphrase cannot be recovered. Do not delete `backend/data/vault.key`.

To move to another computer, including from Windows to a Mac, make an encrypted backup and use Restore there. Restore replaces whatever is in that vault.

Downloaded PDFs and DOCX files, copied lectures, and other exports are not encrypted.

The app talks only to this computer. The one download it can start is the AI model, when you press **Download and install** in Settings: Ollama fetches it from ollama.com, and nothing from your vault is sent.

## How it is organised

The parts are kept separate, and they work together. Sidebar text adapts to light and dark themes, with section colors on icons and counts and a subtle dark-mode gradient. Year folders group lessons into Tagalog and English, with counts and a language filter.

Both libraries accept **PDF and DOCX** files, including a mixed selection or folder. DOCX wording is read directly from the document, without OCR or a Word installation. The original file is encrypted and kept for reading, downloading, moving between libraries, and backup. DOCX files open in a browser preview; page layout can differ from Microsoft Word. Older `.doc` files must be saved as `.docx` first.

The libraries and tools are:

- **All Archives:** every lesson in one list, worship service lessons and pastoral visits together, with tabs for Midweek, Weekend and Pastoral Visits. **Not checked yet** lists every upload still to check.
- **Lesson Library:** your worship service lessons. Drop several PDF or DOCX files at once on the page, choose files or a folder, or use **Upload files** next to its title. Each is read in turn, with its progress shown on the page, and the title, issue, objectives and verses are read from it. Every upload is then checked by hand: **Check what was read** opens the document beside what was read, where you correct anything wrong, remove anything that is not a verse of the lesson, and confirm. Lessons not checked yet are marked **Check**. Visible year folders, made from each lesson's date, list that year's lessons. Use one English/Tagalog search box for title, issue, and objectives; words can match across those fields. Year and language folders narrow the list. **Verses from lessons** lists the verses read from these documents.
- **Pastoral Visits:** your pastoral visit PDFs and DOCX files. Drop several at once on the page, or choose files or a folder; each is read in turn, with its progress shown on the page. Everything uploaded there is filed as a pastoral visit, whatever the file is called. The title is read from the heading, the date from the printed date or a file name starting with it (20210110_...), and the verses from the numbered points. A last-page footer such as **DEPARO, CALOOCAN NORTH** is saved as two separate fields: **Local congregation** and **District**. Check or correct both beside the document. Use one English/Tagalog search box for title, local congregation, and district; words can match across those fields. Year and language folders narrow the list. A verse printed in English and then in Tagalog, or the other way round, is kept as two verses, one in each language. When a scan garbles a book name beyond reading, that verse is left out rather than guessed, and the upload names the line and page so you can add it by hand. Year folders are made from each visit's date, as tabs at the top of the page and under Pastoral Visits in the sidebar, with a **No date** folder for any visit whose date could not be read.
- **Verse Library** (under Pastoral Visits): the verses read from pastoral visit documents, and verses imported from Excel files. Every verse is marked **From pastoral visit PDF**, **From pastoral visit DOCX**, or **Imported from Excel**, with the file it came from, and the list can be filtered by source.
- **Import Verses** (under Pastoral Visits): imports verses from an Excel file into the Verse Library.
- **Lesson Assistant** (the Lecture Maker): builds lectures from the verses in both libraries. Every verse is labelled with where it came from: **Verse Library** with the Excel row or the pastoral visit and page, or **Lesson Library** with the lesson and page.

A verse cited by a worship service lesson belongs to the Lesson Library, even if a pastoral visit cites it too. A verse that no lesson cites any more, such as one you verified before deleting its lesson, is kept in the Verse Library.

When a pastoral visit cites a verse already in the Verse Library, including a translation-project Excel import, **Check what was read** shows the document wording beside the existing wording and its translation. Choose **Use existing verse** to attach that verse to the visit, or **Keep both** to retain the two records. Every comparison needs a choice before the visit can be confirmed. The visit's date is kept with its verse usage, and follows any correction to the visit's date; the existing verse's wording is preserved.

## Search and moving lessons

Press **Ctrl+K** (or **Cmd+K** on Mac), or choose **Advanced search** in the header, from any page. Search titles, issues, objectives, document text, verse wording and references, local congregations, districts, and locations. Narrow results by collection, language, year, review status, or translation. Use the arrow keys to browse results, Enter to open, and Esc to close. The query is kept in memory while you work.

Common English/Tagalog terms and Bible book names are matched using the same offline keyword vocabulary in the browser and backend. Matching ignores case, accents, and punctuation. For broader verse matches, use **Find verses by meaning** with the local AI model. A standalone Excel verse has no inferred year; year filters use dated lesson sources.

Use the **Move to another library** icon on a lesson row to refile a misplaced PDF or DOCX between Pastoral Visits and Lesson Library. When moving to Lesson Library, choose Midweek or Weekend. The original document, lesson identity, date, language, metadata, and verified wording are preserved; shared or imported verse records are separated when needed to preserve their original library and saved-lecture links. The moved document is marked for checking in its destination.

## Lesson Assistant

Write up to four objectives, one in each field; **Add objective** adds a field. Each objective is given up to five verses, without choosing how many. With more than one objective, each has its own tab above the suggestions, showing how many verses it has and how many you added; the arrow keys move between them. An objective added later gets its own verses, and its tab opens, when you press Suggest verses again, and those already found for the others stay. Verses come only from your two libraries, shown exactly as stored. If fewer than three match, the app says so instead of adding unrelated verses. If none of them suit you, **Suggest more** brings the next matches for that objective, never repeating one already shown, until nothing else matches.

Verses from the Lesson Library follow how a lesson is built. A lesson teaches its first objective in the beginning (Pasimula or Introduction), its second in part I., its third in II., and so on, and each part asks questions with verses under them. Your objective is compared with every lesson's own objectives, together with each part's heading and questions, and only the verses printed in a part that matches are suggested, those answering a matching question first. One objective can draw verses from several lessons. A lesson without objectives, such as a pastoral visit, is compared as a whole. If you enter only an issue or topic, it is compared with whole lessons instead, and their verses come from across each lesson. Each such suggestion shows the lesson, its original file, the objective and part it was found under, and the question it answers there. Verse Library verses are matched by their wording.

When you check an uploaded lesson, each verse shows the objective and part it was read under, so a wrong grouping can be caught.

With the local AI running, each verse also has details, folded away until you open them: who is speaking, a **chapter context**, a **book context** and a **historical and political context**. These are the model's reading, not scripture, and can be wrong, so they are labelled until you review or correct them. Each context is written once and shared by all its verses, so a correction applies everywhere and later searches are quicker. Your wording is kept, later AI runs leave it alone, and it never changes the verse.

Tagalog AI context uses the library's book names **I Hari** and **II Hari**. Older, unreviewed AI translations use these names when displayed or exported, too.

The English and Tagalog switch shows these details in either language. Tagalog is translated by the local model the first time you open them, then kept. It is reviewed separately, so a machine translation stays labelled as AI even when you have reviewed the English. A small model's Tagalog needs checking closely; correct it under Review or correct.

The **Lecture outline** beside the form is built like your lesson PDFs: the title (required), the issue and up to four objectives (both optional), then a part for each objective. As in a lesson, the first objective is taught in the Introduction (Pasimula), the second in part I., the third in II., and so on, and each part's verses are lettered A., B., C. Verses move up and down within their part.

**Preview Lecture** shows the outline as it will print: a clean page like a lesson, with headings in English or Tagalog and, if you want it, the AI context under each verse (off by default). From there, or from the outline, you can print or save as PDF (only the lecture prints, never the app), download a Word file laid out the same way, or copy it as text. Saved lectures keep each verse under its objective. Word files and printouts are not encrypted.

## Importing verses

**Import Verses**, under Pastoral Visits, imports an Excel file into the Verse Library. It is also reached from the Verse Library's **Import from Excel** button. The sheet needs these columns in its first row, in any order: Translation (or PET), Book, Chapter, Verse and Content.

The file is read in memory and not kept. The original on your computer is not encrypted, so keep it somewhere safe or delete it afterwards. Verses kept in Google Sheets are imported the same way: in Google Sheets choose File, Download, Microsoft Excel (.xlsx), then choose that file.

You see a preview before anything is saved. Language is read from each row's words, because a translation code does not say what language a row is in. Misspelled books and Excel's drag-fill of a code (AMP2015, AMP2016, ...) are corrected and listed. When the text starts with a number other than the Verse column's, stuck to the first word as in `9Ang`, the column is taken as right and the number is removed. A number followed by a space may belong to the sentence, so that row is imported and marked for you to check.

A book missing its number ("Peter") could be either book, so that row is left out and kept under **Rows to fix** on the Import Verses page, where you choose the book and save it. You can also fix it in the sheet and import again: rows already in the vault are not added twice.

Imported verses are encrypted like the rest of the vault, and stay unverified until you check them. The original cell is kept beside the cleaned text. **Remove imported verses** undoes an import, keeping anything you verified or use in a saved lecture.

## Other tools

The workspace uses a subtle grid and blue gradient in both light and dark themes. Page gutters, card padding, and wrapping controls adjust to the screen size; verse cards, editors, PDFs, and printed lecture pages keep clear reading surfaces.

Printed verse numbers, such as `8Subalit` or `20 Ang`, appear as superscripts throughout the verse views, review previews, original-cell displays, and lecture printouts and Word files. Editing and copying keep the original plain text. The translation code **T4T** is recognized in PDFs; an OCR reading of **TAT** is displayed as **T4T**, including for older records.

- **Verse Library and Verses from lessons:** each count is of verse records. Review Verses counts every verse still unverified in both libraries, so it can be higher than either one. Three views: **Cards**; **Table**, one verse to a line in the same columns as an imported sheet, opening to the full card; and **Parallel**, two languages or translations side by side for each reference. Filter by book, translation, language and status, one page at a time, with pagination at the top and bottom. Extra translations of a reference fold away. Search and filters work from memory, and the app keeps nothing readable on disk or in the browser's cache.
- **Review Verses:** steps through unverified verses, the Verse Library and the Lesson Library each on its own tab. A verse read from a PDF is shown beside its page, highlighted where it is printed, and the page scrolls to it, even at the bottom or running on to the next page. On a scanned page the app reads the page once more to find the lines, in memory only. When the wording cannot be matched, nothing is highlighted and it says so. Verifying locks a verse permanently.
- **Find by meaning:** finds verses related to a question even when they share no words, in Tagalog or English. Available in the Lesson Assistant, both verse lists and Search. It suggests from your library only, and falls back to matching words if the model is off.
- **Select a folder:** when uploading, adds every PDF and DOCX in a folder, skips other files, and flags lessons to check.
- **Backup reminder:** appears if you have lessons and no backup in the last 14 days.
- **Welcome screen:** greets you as the app opens, with what is in the vault, while the vault loads. It steps aside after a few seconds, or at once with **Skip** or Esc; resting the pointer on it holds it. Turn it off there or in Settings, Appearance.

## Local AI (optional)

Install [Ollama](https://ollama.com/download), then open **Settings** and press **Download and install** in the AI assistant card. Ollama downloads and installs both models in one step, about 3.2 GB, with the progress shown. Or from a terminal:

    ollama pull llama3.2:3b
    ollama pull bge-m3

`llama3.2:3b` writes notes and context. `bge-m3` powers Find by meaning. Everything else works without them. If you change `LV_OLLAMA_EMBED_MODEL`, the similarity threshold in `backend/src/semantic.rs` needs measuring again.

## Test

    npm test

This builds everything, then runs the Rust unit tests and the Playwright suite. Install the test tools once first: `cd e2e && npm ci && npx playwright install chromium`.

Tests use their own ports (47329, 47321) and a throwaway database. See `project_plan_deep_review.md`, Part 3, for results and known limits.

The real sample lessons are sensitive, so they and any text from them are kept out of this repository. Set `LV_SAMPLES` to a private folder with `samples.json` and `fixtures/` (default: `../LeksiyonLibrary-private`). Without it, the two Rust tests that use samples skip themselves, and the Playwright suite cannot start.

Test traces and screenshots are off because they would show lesson pages. Set `LV_DEBUG_ARTIFACTS=1` to turn them on. A failed test also writes a text snapshot of the page, so delete `e2e/test-results` after a failed run.
