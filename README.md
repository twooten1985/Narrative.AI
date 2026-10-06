# Narrative AI

Desktop app for law-enforcement interview and jail-call transcription and summary reports. Audio is transcribed with AssemblyAI (or optional local Whisper). Reports are written through the AssemblyAI LLM Gateway. Case files stay in the existing `%APPDATA%\react-example` folder.

## Run locally

Requirements: Node.js 22, ffmpeg on `PATH` for conversion.

```bash
npm install
npm run dev
```

`npm run dev` starts the Express server with the Vite UI. Outside Electron, local API auth is off unless `LOCAL_AUTH_TOKEN` is set. API keys are entered in Settings inside the desktop app and are not stored in the renderer.

## Windows installer

From this folder, on Windows:

```bash
npm install
npm run electron:dist
```

The NSIS installer is written to `dist-electron/`. If `better-sqlite3` fails to load, rebuild it for Electron and package again:

```bash
npm run rebuild
npm run electron:dist
```

`electron:dist` runs `npm run build:all` (Vite production build, then esbuild of `server.ts` to `server.cjs` and `src/services/keyStore.ts` to `electron/keyStore.cjs`) and then `electron-builder build --win`.

Electron stays on 31 so the existing Windows `better-sqlite3` build is unchanged. The user-data directory remains `%APPDATA%\react-example`.

Version 6.1.5. Large recordings are streamed and paged. The renderer does not hold the audio or the full word list. Local Whisper transcribes 10-minute segments. Mass processing runs two files at a time unless Settings changes it (maximum 4). A long recording is summarized in pieces, and a report that hits the model length limit is continued and merged so the final section is saved, shown, and exported. The merged report includes one Final Summary covering the whole recording.

AssemblyAI uploads use a 3-hour undici timeout (the default 300 second header timeout was aborting slow mobile uploads) and retry the whole file up to 4 times when the connection drops. Video and WAV are converted to 96 kbps mono MP3 before that upload. The Electron product version is package.json `version` (6.1.5), which electron-builder writes as the Windows ProductVersion; `build.buildVersion` is the FileVersion.

Speaker letters (Speaker A, Speaker B) come from AssemblyAI diarization. That service does not return legal names. On the transcript tab, each speaker can be renamed. A suggestion is offered only when that speaker states a name ("My name is…", "I am Detective…") or answers "state your name." The reporting officer in Settings is context for the model and is not assigned to a speaker unless the transcript or the saved name already connects them. Unknown speakers stay "Speaker B" (or "Unidentified male" / "Unidentified female" only when the transcript states sex). Saved names are what the transcript lines, the narrative, and DOCX/PDF export use. Change a name and regenerate the narrative to update the report. The model is instructed not to invent a name.

Copy Final Summary copies that section as plain text, without Markdown or HTML, plus the AI disclaimer and the acknowledgement line.

Each launch shows an acknowledgement that AI can make mistakes and that the user will check the report. Closing the app is the way out without acknowledging. The time is stored on the report when it is generated (ISO plus a local sentence such as "AI use acknowledged by user on Oct 5, 2026 7:09 PM CDT."). Print, PDF, DOCX, the on-screen footer, and the copied Final Summary reuse that stored time. A later session does not replace it. Reports generated before 6.1.5 have no stored acknowledgement.

Installed builds unpack `server.cjs` beside `app.asar`. Node resolves `require()` from that unpacked file, so it cannot see a package that exists only inside the asar. `undici` is bundled into `server.cjs` with the other server libraries (Express, fluent-ffmpeg). Leaving it external made 6.1.3 exit at startup with `Cannot find module 'undici'`. After `npm run build:server`, `server.cjs` must not contain `require("undici")` or `require('undici')`. `npm test` checks that, and also loads the bundle from a folder that has the sqlite native addon and no `node_modules/undici`.

## Checks

```bash
npx tsc --noEmit
npm run build:server
npm run build
npm test
npm run regress
```

`npm run regress` uses mocked model output and synthetic tones in `regression-samples`. Set `REGRESS_LIVE=1` and `ASSEMBLY_AI_API_KEY` to also make one authenticated AssemblyAI call.
