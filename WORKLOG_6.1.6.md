# Narrative AI 6.1.6 work log (resume notes)
Base: ..\Narrative.AI-6.1.5 (untouched). Originals of changed files: _backup_6.1.5\<same relative path>
Baseline (6.1.5 copy): npm test = 54 pass / 3 fail; the 3 fail only because better-sqlite3 is built for Electron ABI 125.
Run sqlite tests with: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\electron\dist\electron.exe --import tsx --test tests/server.integration.test.ts
Steps: [x] 1 gatewayChat (gatewayErrors.ts, gatewayChat.ts)  [x] 2 tokens/chunks  [x] 3 queue (gatewayQueue.ts, not yet wired in server)  [x] 4 partials in reportPipeline (PartialStore; DB store + server wiring TODO)  [ ] 5 UI  [ ] 6 settings/provider  [ ] 7 mass  [ ] 8 integrity  [ ] 9 export  [ ] 10 tests  [ ] build


[server.ts DONE 2026-10-25] summaryEngine.ts, connectionTest.ts, queue wired, DB partials, report job route (retry/cancel/errorInfo), timeline+lemur via decideEngine, hash at import, narrative on transcript, review route, test-connection, diagnostics, transcript.txt routes. NEXT: reportClient.ts + App.tsx + MassProcessingView UI, then export redesign, tests, version bump, build.

- App.tsx wired: settings state + SummarySettings, EngineBadge, RetryBanner/Cancel, SummaryErrorPanel, review bar, no auto Gemini fallback, blockedGeminiNote only for Gemini.
- MassProcessingView: per-file status words, retry countdown+Cancel, SummaryErrorPanel, Retry failed files, resume at summary via saved transcribeJobId, no automatic engine switching.
- Export redesign: reportExport.ts, reportHtml.ts, reportDocx.ts, electron/pdfOptions.cjs, main.js, scripts/pdf-from-html.cjs + render-sample-report.ts; sample PDF rendered and visually checked. Version bumped to 6.1.6.

## Final (2026-10-25)
- Tests added: tests/gatewayRegression.test.ts (10 mocked-fetch regressions), tests/reportExport.test.ts (10: export, queue, diagnostics, Test connection). npm test 77 tests / 74 pass / 3 fail (better-sqlite3 ABI baseline only). Electron-as-node sqlite tests 4/4 pass. npm run regress ok. tsc clean.
- Installer: dist-electron\Narrative AI Setup 6.1.6.exe SHA-256 317E9C20E376B9B4A11AE2BB0B42BD5B57053ED0DD58C760C74AA046DCE65757 (unsigned, not published).


## Follow-up after the sample review (Oct 25, 2026)
- Timestamps: the sample's summary had hand-written times and a transcript padded with repeated lines, so they never matched (sample-generator defect, not an app defect). The sample is now built from the transcript itself and the generator stops if any cited time is unverified.
- App: new `src/services/timestamps.ts`. Long answers are cut into segments of at most 30 s (real word times) for the model and the transcript table; every [hh:mm:ss] in a finished summary is checked (time exists, quoted words found at that time); a wrong time is corrected when the quote is found once or clearly nearest, otherwise marked `[hh:mm:ss UNVERIFIED]`. Re-checked at export. Header row "Timestamp check".
- Header: "Written by" split into "Transcription" and "Summary".
- Review wording: page one shows only "Machine-generated, requires officer review."; "Not yet reviewed by a person." appears only in the sign-off block.
- Prompt: no gendered pronouns unless the transcript states them; cite only printed times; no description of silent stretches.
- Gaps over 60 s: "No speech transcribed from hh:mm:ss to hh:mm:ss" rows in the PDF/DOCX transcript, and markers in the text the model sees.
- Mass Processing: there was no "Transcript expires" line. The transcript was in memory only (60 min job timer). It is now saved in `saved_transcripts` (local database, purged after 14 days) the moment transcription finishes; Retry reads it back after the timer or a restart; the failed-file panel says so.
- Footer: hash line 8 pt (was 6.5), 0.5 in clear space below the footer text, bottom margin 1.25 in; checked with PyMuPDF on a 46-character case number.
- Tests: tests/followup.test.ts (21) and one new server test (saved transcript fallback).
## Follow-up 2 (Sunday Oct 25, 2026, CT): wording, Unclear Audio order, page breaks, UNVERIFIED marker

- Prompt rule 11 rewritten: name or role at first mention, then "the witness", the role, or singular "they"; no "Ellis stated that Ellis ..."; the ban on he/she/him/her/his/hers/himself/herself stays unless the transcript states gender. New rule 13: Unclear Audio items in time order (Return-only-the-report is now rule 14).
- `findGenderedPronouns` (src/services/timestamps.ts) counts gendered pronouns outside direct quotes. It is a warning, not a block: the pipeline returns `pronounCheck`, server.ts stores it in the report meta and job result, and the export header shows a "Wording check" row only when the count is above zero. The check is cheap and can give a false hit (for example "her" inside a name or a paraphrased quote).
- `sortUnclearAudio` (same file) sorts the Unclear Audio list by the first time in each item (items without a time stay last, in order; numbered lists are renumbered). It is idempotent and runs in the pipeline, in App.buildExportInput, and again in the HTML and DOCX renderers, so older stored reports print in order too.
- Page breaks: `.content p, .content li { orphans: 3; widows: 3 }`; paragraphs up to 700 characters get `class="short"` (`break-inside: avoid`) through `markShortParagraphs`; DOCX gets keepLines and widowControl on those paragraphs. Headings already keep with the next block. On the sample, "2. Executive Summary" now starts page 2 as a whole instead of leaving two lines on page 1; page 1 ends after Case Information.
- UNVERIFIED marker: bold (800), black text, 1.5 pt solid border plus a 0.75 pt outline (looks like a double frame), amber fill that turns light grey in black and white, forced print colours. DOCX: bold, double 1.5 pt border, amber shading.
- scripts/render-sample-report.ts: wording updated to the new style; new `unverified` flag adds one deliberately wrong synthetic time ([00:04:50], inside the silent stretch) and requires exactly one UNVERIFIED.
- Tests: 8 new tests in tests/followup.test.ts (30 in that file). `npm test` 107 tests, 104 pass, 3 fail (the same better-sqlite3 ABI baseline). `npx tsc --noEmit` clean. `npm run regress` passes.
- Backups of every edited file are in `_backup_6.1.5\` (first edit of each file in 6.1.6 was backed up from the 6.1.5 original).
