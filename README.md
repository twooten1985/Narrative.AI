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

Version 6.1.3. Large recordings are streamed and paged. The renderer does not hold the audio or the full word list. Local Whisper transcribes 10-minute segments. Mass processing runs two files at a time unless Settings changes it (maximum 4). A long recording is summarized in pieces, and a report that hits the model length limit is continued and merged so the final section is saved, shown, and exported.

AssemblyAI uploads use a 3-hour undici timeout (the default 300 second header timeout was aborting slow mobile uploads) and retry the whole file up to 4 times when the connection drops. Video and WAV are converted to 96 kbps mono MP3 before that upload. The Electron product version is package.json `version` (6.1.3), which electron-builder writes as the Windows ProductVersion; `build.buildVersion` is the FileVersion.

## Checks

```bash
npx tsc --noEmit
npm run build:server
npm run build
npm test
npm run regress
```

`npm run regress` uses mocked model output and synthetic tones in `regression-samples`. Set `REGRESS_LIVE=1` and `ASSEMBLY_AI_API_KEY` to also make one authenticated AssemblyAI call.
