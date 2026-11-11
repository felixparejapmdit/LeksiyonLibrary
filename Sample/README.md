# Lesson Vault — UI/UX review and three design samples

Open any of these HTML files directly in your browser. Each is a complete, independent prototype with its own styles and JavaScript; no installation or server is needed.

| Sample | Direction | Best suited to |
| --- | --- | --- |
| [01-evergreen.html](01-evergreen.html) | Warm paper, forest green, editorial typography, a familiar sidebar | Everyday browsing, reading, and finding lessons |
| [02-blueprint.html](02-blueprint.html) | A bright preparation desk, blue accents, top navigation, clear task stages | Building lectures and working between suggestions and an outline |
| [03-nocturne.html](03-nocturne.html) | A warm dark reading studio, activity rail, generous comparison panes | Long reading and verse-review sessions |

The files link to one another. Use their navigation to visit the other screens, rather than judging only the opening screen. Buttons demonstrate local interactions, open dialogs, or explain the simulated action. Sample state can be reset by refreshing the page.

| Preview images | Desktop | Mobile |
| --- | --- | --- |
| Evergreen | [View image](previews/01-evergreen.png) | [View image](previews/01-evergreen-mobile.png) |
| Blueprint | [View image](previews/02-blueprint.png) | [View image](previews/02-blueprint-mobile.png) |
| Nocturne | [View image](previews/03-nocturne.png) | [View image](previews/03-nocturne-mobile.png) |

All records and verse prose are illustrative placeholders, not authoritative scripture or material from the real vault. The prototypes do not connect to the app, read your encrypted data, run AI, or import or verify real records. File selection and export controls demonstrate the interaction; they do not reproduce the app's backend. The working application is unchanged.

## Recommendation

**Evergreen is the strongest starting point for the overall application.** This is primarily a reading and preparation tool, so a quieter hierarchy, comfortable text, and familiar navigation matter more than decorative effects. Keep the current separation between Lesson Library and Verse Library, and make the source of each verse easy to see.

Borrow Blueprint's task stages for the Lesson Assistant and imports, and Nocturne's balanced source/text comparison for Review Verses. The dark reading treatment should also be available as an appearance option. These are three alternatives to compare, rather than three interfaces to mix indiscriminately.

## Page-by-page review

This review is based on the current React pages and their shared navigation, PDF reader, dialogs, import controls, and lecture preview. The observations below describe the existing interface; the suggested changes are proposals.

| Page or workflow | Current observation | Suggested UI/UX |
| --- | --- | --- |
| Global navigation | The sidebar combines libraries, nested years, verse collections, imports, and tools. The header also exposes Backup, Restore, and Reset on wide screens. | Keep a short primary navigation with clear groups for libraries and preparation. Expand years within the selected library. Place Backup in a quiet utility area and Restore/Reset in Settings. Keep visible labels for important actions. |
| Welcome and first opening | The welcome screen overlays the application and normally steps aside after a timer. | Offer a nonblocking overview with Continue reading, Prepare a lecture, and Review verses. Retain an optional welcome preference, but let returning users start working immediately. |
| All Archives | The archive reuses the lesson-list/PDF layout, with category tabs and a separate viewer. | Make this a clear combined catalogue, with category and status badges, useful metadata, a visible selection state, and an optional reader. An overview can be an additional landing page; keep All Archives available. |
| Lesson Library | Uploading, drop area, category tabs, years, several filter fields, and the result list share the same pane. | Give Upload PDF one prominent position. Lead with search and years, then put date, issue, and objective under More filters. Show active filter chips and a direct Clear action. Make the result title and date easier to scan. |
| Pastoral Visits | The list needs dates, local congregation, district, years, and source checking, as well as upload controls. | Show congregation and district as separate readable metadata, with compact filters. Keep the library-specific upload destination explicit. Present visit date and checking status in the list; put detailed metadata in a drawer. |
| Verses from lessons | This shares the verse-library interface while retaining lesson provenance and a separate collection. | Keep it clearly named and distinct. Give reference and verse text the strongest hierarchy, with lesson, objective, part, and source-page details available below or on demand. |
| Verse Library | Cards, table, parallel view, search, several filters, provenance, review actions, and pagination are all present. | Keep the useful view switch and top/bottom pagination. Use a shorter default toolbar with an expandable filter area. Make the difference between references and verse records explicit. Show the translation, language, and source once per record without letting badges overpower the text. |
| Review Verses | PDF review is split across a broad source pane and a narrower editor. Excel review can show a small original-cell card in a large empty area, plus a formatted preview, editor, and expandable original text. | Balance the source and wording panes. Label the source precisely, including workbook row or PDF page. Read first; open the editor when Edit wording is chosen. Keep a stable action bar with Previous, Skip, and Verify and lock. Explain the permanent lock next to its confirmation. On phones, switch between Source and Wording instead of compressing both. |
| Lesson Assistant | The issue/objective form, suggestion groups, AI details, and lecture outline occupy two columns. Context can appear before the actual verse in a suggestion. | Use clear stages: Define objectives, Choose verses, Arrange outline, Preview. Show scripture first, source second, and optional AI context after it. Keep the outline visible while adding verses and show which objective receives each addition. Preserve the four-objective limit and Introduction/Part I ordering. |
| Import Verses | The page explains the sheet format in prose, then exposes a file chooser, a report, expandable correction lists, and saved rows to fix. | Use Select file → Review changes → Import. Show the required columns visually. Give new records, duplicates, corrected codes, and rows needing attention separate summaries. Let the user open and repair one problem row without losing the preview. |
| Search | The desktop header searches by navigating back to the archive; the dedicated Search page also shows verses and meaning results. | Use one predictable global search destination, with Lessons, Visits, and Verses result groups or tabs. Label keyword matching and meaning matching clearly. Keep the user's query and filters when opening and returning from a result. |
| Settings | Appearance, data management, and local AI are arranged in cards; backup and destructive actions share a group. | Organize Appearance, Reading, Local AI, and Data & backups as sections. Add a readable text-size control. Keep AI readiness concise, with installation detail available when needed. Put Reset vault in a separate danger area with its existing confirmation. |
| PDF reader | Page navigation, zoom, fit, rotation, language switching, source highlighting, and metadata are useful but compact. | Keep page/zoom controls together, show the document title, and move occasional actions into a menu. Make Fit width and highlighted source navigation easy to find. Preserve the reader position when opening metadata or correcting a verse. |
| Check an uploaded PDF | A modal combines all metadata fields, extracted verses, source comparison, and duplicate-resolution choices. The PDF pane is hidden at smaller widths. | Use a dedicated checking workspace or a roomier dialog with Metadata and Verses sections. Show a checklist and unresolved-comparison count. Keep Use existing verse and Keep both directly beside the compared wordings. On phones, provide an explicit Source tab so comparison remains possible. |
| Lecture preview and export | The existing paper preview correctly separates print content from the app, with language and optional AI context controls. | Preserve the clean document. Give Print/PDF, Word, and Copy one coherent export area. Show objective/verse totals and whether AI context is included before exporting. Keep names, translation codes, superscripts, and provenance consistent with the library. |
| Upload, backup, restore, and confirmations | These workflows already have progress, passphrases, and confirmation checks. | Preserve those safeguards. Keep background uploads visible without covering the current task. Use simple action labels such as Upload lesson PDF rather than technical wording. Show completion and a direct next step, such as Check extracted verses. |

## Shared design rules

- Use a readable base interface size, with larger verse text and comfortable line spacing. Make reading width a deliberate choice rather than stretching prose across an entire monitor.
- Give each screen one primary action. Use a consistent secondary button style and reserve warning colors for decisions that need attention.
- Keep `I Hari`, `II Hari`, and `T4T` consistent. Verse markers appear as superscripts in reading and source displays; the editor preserves plain text.
- Preserve the distinction between scripture, original extraction, corrected wording, and AI context. AI notes remain explicitly labelled and optional.
- Preserve source ownership: lesson verses remain in the Lesson Library; pastoral-visit and spreadsheet verses remain in the Verse Library. A visual redesign must not change these data rules.
- Keep active filters visible, give empty states a useful next action, and retain context when returning from a reader or dialog.
- Use text or icons alongside status colors. Provide visible keyboard focus, labels for icon buttons, comfortable touch targets, and layouts that work on narrow screens.

## What to compare

Try these tasks in each sample:

1. Open Lesson Library, change a year or filter, and inspect a lesson.
2. Open Pastoral Visits and find the local-congregation and district metadata.
3. Open Verse Library, switch the display mode, and try pagination and search.
4. Open Review Verses, inspect the source, and compare Skip with Verify and lock.
5. Open Lesson Assistant, add suggested verses, rearrange the outline, and preview it.
6. Open Import Verses and Settings to compare the supporting workflows.

Choose the layout that makes those tasks easiest, then refine its spacing, color, and typography. The prototypes are review artifacts; applying a chosen design to React is a separate implementation step.

## Verification

Checked all 11 views in each prototype in Chromium at desktop (1440 × 1000) and mobile (390 × 844) sizes: 66 navigation checks, with no JavaScript errors or page-level horizontal overflow. Also exercised verse display modes and search, assistant selection/save/preview, review confirmation, import previews, document dialogs, and appearance controls. Inline JavaScript syntax and sibling HTML links were checked. The images above are captured from the local prototypes.
