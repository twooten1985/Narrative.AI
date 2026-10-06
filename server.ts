import express from "express";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import { fileURLToPath } from "url";
import { formatAiAcknowledgement } from "./src/services/audit";
import { formatTranscriptForLLM } from "./src/services/reportPrompts";
import { listSpeakers, suggestSpeakerNames } from "./src/services/speakerNames";
import { sanitizeReport } from "./src/services/sanitizeReport";
import { cleanStoredText } from "./src/services/cleanReports";
import { generateInvestigativeReport, withTruncationWarning, type ChatFn } from "./src/services/reportPipeline";
import { generateCaseTimeline, transcriptPreview } from "./src/services/timelinePipeline";
import { planWhisperSegments, stitchWhisperSegments, wavPcm16ToFloat32 } from "./src/services/whisperSegments";
import { testAssemblyAiKey, testGeminiKey } from "./src/services/keyTest";
import { keywordHits } from "./src/services/keywordHits";
import { runRegression } from "./src/regression/runRegression";
import { gatewayChat } from "./src/services/gatewayChat";
import { buildTranscriptRequest, createTranscript, deleteRemoteTranscript, formatCauseChain, getTranscript, streamUploadAudio } from "./src/services/aaiClient";
import { assertSpeechUploadTarget, isConvertedSpeechFile, needsSpeechConversion, SPEECH_AUDIO_BITRATE, SPEECH_AUDIO_CHANNELS } from "./src/services/speechAudio";
import { geminiGenerateContent, apodUserPrompt, GEMINI_MODEL_ID } from "./src/services/geminiRest";
import { pollWithBackoff } from "./src/services/polling";
import { DEFAULT_APP_SETTINGS, normalizeAppSettings, type AppSettings } from "./src/services/settings";
import {
  DEFAULT_AAI_API_BASE,
  DEFAULT_LLM_GATEWAY_URL,
  JSON_BODY_LIMIT,
  isHttpsOrLocalUrl,
  normalizeModelId,
} from "./src/services/config";

const AUTH_TOKEN = process.env.LOCAL_AUTH_TOKEN || "";

const secrets = {
  assemblyai: process.env.ASSEMBLY_AI_API_KEY || "",
  gemini: process.env.GEMINI_API_KEY || "",
};

const allowedImportPaths = new Set<string>();

process.on("message", (msg: any) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "secrets") {
    if (typeof msg.assemblyai === "string") secrets.assemblyai = msg.assemblyai;
    if (typeof msg.gemini === "string") secrets.gemini = msg.gemini;
    console.log(`[secrets] assemblyai=${secrets.assemblyai ? "set" : "empty"} gemini=${secrets.gemini ? "set" : "empty"}`);
  }
  if (msg.type === "allow-paths" && Array.isArray(msg.paths)) {
    for (const entry of msg.paths) {
      if (typeof entry === "string" && entry.trim()) allowedImportPaths.add(path.resolve(entry));
    }
    if (process.send) process.send({ type: "paths-allowed", id: msg.id });
  }
});

function logMemory(reason: string) {
  const usage = process.memoryUsage();
  console.log(`[memory] ${reason} rss=${usage.rss} heapUsed=${usage.heapUsed} heapTotal=${usage.heapTotal} external=${usage.external}`);
}

const getDirname = () => {
  try {
    if (typeof __dirname !== "undefined") return __dirname;
  } catch (e) {}
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch (e) {
    return process.cwd();
  }
};

const _dirname = getDirname();
const isProduction = process.argv.includes("--production") || process.env.NODE_ENV === "production";

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

const getDatabase = (dbPath: string) => {
  if (isProduction) {
    const possibleNativePaths = [
      path.join(_dirname, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
      path.join(process.cwd(), "resources", "app.asar.unpacked", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    ];
    for (const nativePath of possibleNativePaths) {
      if (fs.existsSync(nativePath)) {
        console.log(`Found native sqlite binary at: ${nativePath}`);
        return new Database(dbPath, { nativeBinding: nativePath });
      }
    }
  }
  return new Database(dbPath);
};

const userDataPath = process.env.APP_USER_DATA_PATH || process.cwd();
const dbPath = path.join(userDataPath, "narrative.db");
const db = getDatabase(dbPath);

const uploadDir = path.join(userDataPath, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

interface ConversionState {
  progress: number;
  outputFilename: string;
  error?: string;
  /** Resolves to the finished MP3 path. Rejects if ffmpeg fails. */
  resultPromise: Promise<string>;
}

const conversionJobs = new Map<string, ConversionState>();
const conversionByOutput = new Map<string, Promise<void>>();

// 96 kbps mono — see speechAudio.ts. Progress stays under 100 until the caller
// finishes any database update, so clients do not treat a video as ready.
const extractAudio = (inputPath: string, outputPath: string, onProgress?: (pct: number) => void): Promise<void> => {
  return new Promise((resolve, reject) => {
    onProgress?.(0);
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(SPEECH_AUDIO_CHANNELS)
      .audioBitrate(SPEECH_AUDIO_BITRATE)
      .audioCodec("libmp3lame")
      .toFormat("mp3")
      .on("progress", (progress) => {
        if (progress.percent != null && !Number.isNaN(progress.percent)) {
          onProgress?.(Math.max(0, Math.min(99, Math.round(progress.percent))));
        }
      })
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
};

function beginConversion(jobId: string, inputPath: string, outputFilename: string, afterFile?: () => void): Promise<string> {
  const existing = conversionJobs.get(jobId);
  if (existing?.resultPromise && !existing.error && existing.progress < 100) return existing.resultPromise;
  const outputPath = path.join(uploadDir, outputFilename);
  const state: ConversionState = {
    progress: 0,
    outputFilename,
    resultPromise: Promise.resolve(outputPath),
  };
  const resultPromise = extractAudio(inputPath, outputPath, (pct) => {
    state.progress = pct;
  }).then(() => {
    const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    if (!size) throw new Error("Converted speech audio is empty.");
    afterFile?.();
    state.progress = 100;
    return outputPath;
  }).catch((err: any) => {
    state.error = err?.message || "Audio conversion failed";
    console.error("[convert] failed:", state.error);
    throw err;
  });
  state.resultPromise = resultPromise;
  conversionJobs.set(jobId, state);
  const finished = resultPromise.then(() => undefined);
  // Mark the side promise handled so a failed conversion does not surface as
  // an unhandled rejection when nobody is waiting on the output name.
  finished.catch(() => {});
  conversionByOutput.set(outputFilename, finished);
  return resultPromise;
}

function conversionProgressPayload(id: string): { status: number; body: Record<string, unknown> } {
  const job = conversionJobs.get(id);
  if (job?.error) {
    return { status: 500, body: { error: `Audio conversion failed: ${job.error}`, progress: job.progress, status: "error" } };
  }
  if (job) {
    return { status: 200, body: { progress: job.progress, status: job.progress >= 100 ? "completed" : "processing" } };
  }
  const recording = db.prepare("SELECT filename, transcription_filename FROM recordings WHERE id = ?").get(id) as { filename?: string; transcription_filename?: string } | undefined;
  if (recording && isConvertedSpeechFile(recording.filename || "", recording.transcription_filename)) {
    return { status: 200, body: { progress: 100, status: "completed" } };
  }
  return { status: 404, body: { error: "Job not found" } };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    timeline_report TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    transcription_filename TEXT,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    transcript JSON,
    summary TEXT,
    apod_results JSON,
    speaker_labels JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS aai_deletion_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript_id TEXT,
    recording_id TEXT,
    deleted_at TEXT,
    success INTEGER,
    detail TEXT
  );
`);

function ensureColumn(table: string, column: string, ddl: string) {
  try {
    db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).get();
  } catch {
    try {
      db.exec(ddl);
    } catch (alterError) {
      console.error(`[DB] Failed to add ${table}.${column}:`, alterError);
    }
  }
}

ensureColumn("cases", "timeline_report", "ALTER TABLE cases ADD COLUMN timeline_report TEXT;");
ensureColumn("cases", "timeline_meta", "ALTER TABLE cases ADD COLUMN timeline_meta TEXT;");
ensureColumn("recordings", "interview_type", "ALTER TABLE recordings ADD COLUMN interview_type TEXT;");
ensureColumn("recordings", "report_meta", "ALTER TABLE recordings ADD COLUMN report_meta TEXT;");
ensureColumn("recordings", "aai_deleted_at", "ALTER TABLE recordings ADD COLUMN aai_deleted_at TEXT;");

function getSettings(): AppSettings {
  const row = db.prepare("SELECT json FROM app_settings WHERE id = 1").get() as { json?: string } | undefined;
  if (!row?.json) return { ...DEFAULT_APP_SETTINGS };
  try {
    return normalizeAppSettings(JSON.parse(row.json));
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

function saveSettings(settings: AppSettings) {
  const json = JSON.stringify(settings);
  db.prepare("INSERT INTO app_settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(json);
}

function resolveApiBase(settings = getSettings()): string {
  const envUrl = process.env.ASSEMBLYAI_API_BASE;
  if (envUrl && settings.aaiApiBase === DEFAULT_AAI_API_BASE && isHttpsOrLocalUrl(envUrl)) return envUrl.replace(/\/$/, "");
  return settings.aaiApiBase;
}

function resolveGatewayUrl(settings = getSettings()): string {
  const envUrl = process.env.LLM_GATEWAY_URL;
  if (envUrl && settings.llmGatewayUrl === DEFAULT_LLM_GATEWAY_URL && isHttpsOrLocalUrl(envUrl)) return envUrl;
  return settings.llmGatewayUrl;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  },
});

// Audio is streamed to disk by multer. JSON bodies are transcripts and settings, not media.
const upload = multer({ storage });

function acknowledgementIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function parseJsonField(value: any) {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

const parseRecording = (rec: any) => {
  if (!rec) return rec;
  return {
    ...rec,
    transcript: parseJsonField(rec.transcript),
    apod_results: parseJsonField(rec.apod_results),
    speaker_labels: parseJsonField(rec.speaker_labels),
    report_meta: parseJsonField(rec.report_meta),
  };
};

function tokenMatches(presented: string): boolean {
  if (!AUTH_TOKEN || !presented || presented.length !== AUTH_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(AUTH_TOKEN));
}

function readCookie(header: string, name: string): string {
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

let warnedOpenAuth = false;
function requireLocalAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!AUTH_TOKEN) {
    if (isProduction) return res.status(500).json({ error: "Local auth token is not configured." });
    if (!warnedOpenAuth) {
      console.warn("[auth] LOCAL_AUTH_TOKEN is not set; local API auth is disabled. The desktop app always sets a token.");
      warnedOpenAuth = true;
    }
    return next();
  }
  const header = req.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const cookie = readCookie(req.get("cookie") || "", "local_token");
  if (tokenMatches(bearer) || tokenMatches(cookie)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function safeBasename(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const base = path.basename(name);
  if (base !== name || base === "." || base === ".." || base.includes("\0")) return null;
  return base;
}

interface Job {
  status: "running" | "completed" | "error";
  progress: number;
  message: string;
  error?: string;
  transcript?: any;
  transcriptId?: string;
  result?: any;
}

const jobs = new Map<string, Job>();

function trackJob(id: string, job: Job) {
  jobs.set(id, job);
  const timer = setTimeout(() => jobs.delete(id), 60 * 60 * 1000);
  timer.unref?.();
}

function publicJob(job: Job) {
  return {
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    transcriptId: job.transcriptId,
    result: job.result,
    hasTranscript: Boolean(job.transcript),
  };
}

const RECORDING_META_SQL = `id, case_id, filename, transcription_filename, original_name, mime_type, size,
  summary, apod_results, speaker_labels, interview_type, report_meta, aai_deleted_at, created_at,
  CASE WHEN transcript IS NULL OR length(transcript) = 0 THEN 0 ELSE 1 END AS has_transcript`;

function recordingMeta(rec: any) {
  if (!rec) return rec;
  const parsed = parseRecording({ ...rec, transcript: null });
  return { ...parsed, transcript: null, has_transcript: rec.has_transcript === 1 || rec.has_transcript === true };
}

function readStoredTranscript(recordingId: string): any | null {
  const row = db.prepare("SELECT transcript FROM recordings WHERE id = ?").get(recordingId) as { transcript?: string } | undefined;
  if (!row?.transcript) return null;
  return parseJsonField(row.transcript);
}

const MEDIA_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".wma", ".mp2", ".amr", ".mp4", ".mov", ".mpg", ".mpeg", ".avi", ".mkv", ".wmv", ".webm", ".3gp", ".ts", ".m2ts"]);

async function copyChosenMedia(sourcePath: string): Promise<{ filename: string; originalname: string; mimetype: string; size: number; filePath: string }> {
  const resolved = path.resolve(sourcePath);
  if (!allowedImportPaths.has(resolved)) {
    const error: any = new Error("That file was not chosen in the desktop app.");
    error.status = 403;
    throw error;
  }
  allowedImportPaths.delete(resolved);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error("File not found.");
  const ext = path.extname(resolved).toLowerCase();
  if (!MEDIA_EXT.has(ext)) throw new Error("That file type is not a supported recording.");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `${uuidv4()}${ext}`;
  const filePath = path.join(uploadDir, filename);
  await fs.promises.copyFile(resolved, filePath);
  const size = fs.statSync(filePath).size;
  const mimetype = ext === ".mp4" || ext === ".mov" || ext === ".avi" || ext === ".mkv" || ext === ".webm" || ext === ".wmv" || ext === ".mpg" || ext === ".mpeg" || ext === ".3gp" || ext === ".ts" || ext === ".m2ts"
    ? "video/mp4"
    : ext === ".wav"
      ? "audio/wav"
      : "audio/mpeg";
  return { filename, originalname: path.basename(resolved), mimetype, size, filePath };
}

function probeDurationMs(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(Math.round(((data as any)?.format?.duration || 0) * 1000));
    });
  });
}

function extractWavSegment(inputPath: string, outputPath: string, startMs: number, durationMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startMs / 1000)
      .setDuration(Math.max(0.1, durationMs / 1000))
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

function backupDatabase(): string {
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (error) { console.error("[DB] checkpoint failed:", error); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(path.dirname(dbPath), `narrative-backup-${stamp}.db`);
  fs.copyFileSync(dbPath, dest);
  console.log(`[DB] Backup written to ${dest}`);
  return dest;
}

function gatewayFor(model: string): ChatFn {
  return (args) => gatewayChat({
    url: resolveGatewayUrl(),
    apiKey: secrets.assemblyai,
    model,
    messages: args.messages,
    maxTokens: args.maxTokens,
    temperature: args.temperature,
  });
}

function geminiFor(): ChatFn {
  return async (args) => {
    const system = args.messages.find((message) => message.role === "system")?.content || "";
    const user = args.messages.find((message) => message.role === "user")?.content || "";
    const result = await geminiGenerateContent({
      apiKey: secrets.gemini,
      system,
      user,
      maxOutputTokens: args.maxTokens || 32768,
    });
    return {
      content: result.text,
      model: result.model,
      requestId: null,
      finishReason: result.finishReason,
    };
  };
}

async function speechFileForRecording(recording: {
  id: string;
  filename: string;
  transcription_filename?: string | null;
  mime_type?: string | null;
  original_name?: string | null;
}, preferredOutput?: string): Promise<string> {
  const source = {
    filename: recording.filename,
    mimeType: recording.mime_type,
    originalName: recording.original_name,
  };
  const currentName = recording.transcription_filename || recording.filename;
  if (!needsSpeechConversion(source)) return path.join(uploadDir, currentName);
  if (isConvertedSpeechFile(recording.filename, recording.transcription_filename)) {
    const ready = path.join(uploadDir, recording.transcription_filename as string);
    if (fs.existsSync(ready) && fs.statSync(ready).size > 0) return ready;
  }
  const existing = conversionJobs.get(recording.id);
  if (existing?.resultPromise && !existing.error && existing.progress < 100) {
    console.log(`[aai] waiting for speech conversion of ${recording.filename}`);
    return existing.resultPromise;
  }
  const outputFilename = preferredOutput || `${uuidv4()}.mp3`;
  const inputPath = path.join(uploadDir, recording.filename);
  return beginConversion(recording.id, inputPath, outputFilename, () => {
    db.prepare("UPDATE recordings SET transcription_filename = ? WHERE id = ?").run(outputFilename, recording.id);
  });
}

async function resolveAudioForTranscription(body: any): Promise<{ filePath: string; recordingId: string | null }> {
  if (body?.recordingId) {
    const recording = db.prepare("SELECT * FROM recordings WHERE id = ?").get(body.recordingId) as any;
    if (!recording) throw new Error("Recording not found");
    const filePath = await speechFileForRecording(recording);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).size) throw new Error("Audio file not found for transcription.");
    assertSpeechUploadTarget({
      filename: recording.filename,
      mimeType: recording.mime_type,
      originalName: recording.original_name,
    }, path.basename(filePath));
    return { filePath, recordingId: recording.id };
  }
  const filename = safeBasename(body?.filename);
  if (!filename) throw new Error("A recording id or file name is required.");
  const pending = conversionByOutput.get(filename);
  if (pending) await pending;
  let filePath = path.join(uploadDir, filename);
  if (needsSpeechConversion({ filename })) {
    const outputFilename = `${uuidv4()}.mp3`;
    filePath = await beginConversion(`file:${filename}`, filePath, outputFilename);
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).size) throw new Error("Audio file not found for transcription.");
  assertSpeechUploadTarget({ filename }, path.basename(filePath));
  return { filePath, recordingId: null };
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ limit: "2mb", extended: true }));
  app.use("/api", requireLocalAuth);
  app.use("/uploads", requireLocalAuth);

  app.get("/health", requireLocalAuth, (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/session", (_req, res) => {
    if (AUTH_TOKEN) {
      res.setHeader("Set-Cookie", `local_token=${encodeURIComponent(AUTH_TOKEN)}; HttpOnly; SameSite=Strict; Path=/`);
    }
    res.json({ ok: true });
  });

  app.get("/api/settings", (_req, res) => {
    res.json({
      ...getSettings(),
      hasAssemblyKey: Boolean(secrets.assemblyai),
      hasGeminiKey: Boolean(secrets.gemini),
    });
  });

  app.put("/api/settings", (req, res) => {
    const next = normalizeAppSettings({ ...getSettings(), ...req.body });
    saveSettings(next);
    res.json({
      ...next,
      hasAssemblyKey: Boolean(secrets.assemblyai),
      hasGeminiKey: Boolean(secrets.gemini),
    });
  });

  app.get("/api/cases", (_req, res) => {
    const cases = db.prepare("SELECT * FROM cases ORDER BY created_at DESC").all() as any[];
    res.json(cases.map((row) => ({ ...row, timeline_meta: parseJsonField(row.timeline_meta) })));
  });

  app.get("/api/stats", (_req, res) => {
    try {
      const totalCases = db.prepare("SELECT COUNT(*) as count FROM cases").get() as any;
      const totalRecordings = db.prepare("SELECT COUNT(*) as count FROM recordings").get() as any;
      const totalSize = db.prepare("SELECT SUM(size) as total FROM recordings").get() as any;
      const mimeTypes = db.prepare("SELECT mime_type, COUNT(*) as count FROM recordings GROUP BY mime_type").all();
      const recentActivity = db.prepare(`
        SELECT date(created_at) as date, COUNT(*) as count
        FROM recordings
        WHERE created_at > date('now', '-7 days')
        GROUP BY date(created_at)
        ORDER BY date ASC
      `).all();
      res.json({
        totalCases: totalCases.count,
        totalRecordings: totalRecordings.count,
        totalSize: totalSize.total || 0,
        mimeTypes,
        recentActivity,
      });
    } catch (error) {
      console.error("Stats fetch failed:", error);
      res.status(500).json({ error: "Failed to fetch statistics" });
    }
  });

  app.post("/api/cases", (req, res) => {
    const { name, description } = req.body;
    const id = uuidv4();
    db.prepare("INSERT INTO cases (id, name, description) VALUES (?, ?, ?)").run(id, name, description);
    res.json({ id, name, description });
  });

  app.get("/api/cases/:id", (req, res) => {
    const caseData = db.prepare("SELECT * FROM cases WHERE id = ?").get(req.params.id) as any;
    if (!caseData) return res.status(404).json({ error: "Case not found" });
    const recordings = db.prepare(`SELECT ${RECORDING_META_SQL} FROM recordings WHERE case_id = ? ORDER BY created_at DESC`).all(req.params.id);
    res.json({
      ...caseData,
      timeline_meta: parseJsonField(caseData.timeline_meta),
      recordings: recordings.map(recordingMeta),
    });
  });

  app.patch("/api/cases/:id", (req, res) => {
    const { name, description, timeline_report, timeline_meta } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (name !== undefined) { updates.push("name = ?"); params.push(name); }
    if (description !== undefined) { updates.push("description = ?"); params.push(description); }
    if (timeline_report !== undefined) { updates.push("timeline_report = ?"); params.push(timeline_report); }
    if (timeline_meta !== undefined) { updates.push("timeline_meta = ?"); params.push(JSON.stringify(timeline_meta)); }
    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });
    params.push(req.params.id);
    db.prepare(`UPDATE cases SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    res.json({ success: true });
  });

  app.get("/api/cases/:id/timeline", (req, res) => {
    try {
      const caseObj = db.prepare("SELECT timeline_report, timeline_meta FROM cases WHERE id = ?").get(req.params.id) as any;
      if (!caseObj) return res.status(404).json({ error: "Case not found" });
      res.json({
        timelineReport: caseObj.timeline_report || null,
        timelineMeta: parseJsonField(caseObj.timeline_meta),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/cases/:id/timeline", async (req, res) => {
    const { id } = req.params;
    const settings = getSettings();
    const engine = req.body?.engine === "gemini" ? "gemini" : "gateway";
    const strictlyAssembly = req.body?.strictlyAssembly === true;
    if (engine === "gemini" && (!settings.allowGemini || strictlyAssembly)) {
      return res.status(403).json({
        error: "Google Gemini is turned off for case data. AssemblyAI was not able to complete this request, and nothing was sent to Google.",
        code: "GEMINI_DISABLED",
      });
    }
    if (engine === "gateway" && !secrets.assemblyai) {
      return res.status(400).json({ error: "An AssemblyAI API key is required to generate a timeline." });
    }
    if (engine === "gemini" && !secrets.gemini) {
      return res.status(400).json({ error: "A Gemini API key is required for that retry." });
    }

    try {
      const recordings = db.prepare("SELECT id, original_name, interview_type, summary, speaker_labels FROM recordings WHERE case_id = ?").all(id) as any[];
      if (recordings.length === 0) {
        return res.status(400).json({ error: "No recordings found in this case. Please upload files and generate summaries first." });
      }
      const sources = [];
      const readOne = db.prepare("SELECT transcript FROM recordings WHERE id = ?");
      for (const rec of recordings) {
        let preview = "";
        let transcriptId: string | null = null;
        const blob = readOne.get(rec.id) as { transcript?: string } | undefined;
        if (blob?.transcript) {
          try {
            const parsed = JSON.parse(blob.transcript);
            transcriptId = parsed?.id || null;
            preview = transcriptPreview(parsed, parseJsonField(rec.speaker_labels));
          } catch (e) {}
        }
        sources.push({
          name: rec.original_name,
          interviewType: rec.interview_type,
          summary: rec.summary,
          preview,
          transcriptId,
        });
      }
      const model = normalizeModelId(req.body?.model);
      const chat = engine === "gemini" ? geminiFor() : gatewayFor(model);
      const generated = await generateCaseTimeline({
        sources,
        model,
        tokenLimit: settings.chunkTokenLimit,
        chat,
        onProgress: (message) => console.log(`[timeline] ${message}`),
      });
      const meta = {
        engine: engine === "gemini" ? "gemini" : "assemblyai-gateway",
        model: generated.model,
        requestId: generated.requestId,
        transcriptId: generated.transcriptIds.join(", ") || null,
        generatedAt: new Date().toISOString(),
        truncated: generated.truncated,
      };
      db.prepare("UPDATE cases SET timeline_report = ?, timeline_meta = ? WHERE id = ?").run(generated.text, JSON.stringify(meta), id);
      res.json({ timelineReport: generated.text, timelineMeta: meta });
    } catch (error: any) {
      console.error("Timeline generation error:", error);
      logMemory("timeline-error");
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/cases/:id/recordings", upload.single("file"), async (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const id = uuidv4();
    const { id: caseId } = req.params;
    const { filename, originalname, mimetype, size, path: filePath } = req.file;
    const isVideo = mimetype.startsWith("video/");
    const isWav = mimetype === "audio/wav" || mimetype === "audio/x-wav" || originalname.toLowerCase().endsWith(".wav");

    if (isVideo || isWav) {
      const audioFilename = `${uuidv4()}.mp3`;
      db.prepare(`
        INSERT INTO recordings (id, case_id, filename, transcription_filename, original_name, mime_type, size)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, caseId, filename, filename, originalname, mimetype, size);
      speechFileForRecording({
        id,
        filename,
        transcription_filename: filename,
        mime_type: mimetype,
        original_name: originalname,
      }, audioFilename).catch((err) => console.error("Background conversion failed:", err));
      return res.json({ id, filename, transcriptionFilename: audioFilename, originalname, mimetype, size, status: "converting" });
    }

    db.prepare(`
      INSERT INTO recordings (id, case_id, filename, transcription_filename, original_name, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, caseId, filename, filename, originalname, mimetype, size);
    res.json({ id, filename, transcriptionFilename: filename, originalname, mimetype, size, status: "ready" });
  });

  app.post("/api/recordings/:id/convert", async (req, res) => {
    const { id } = req.params;
    const recording = db.prepare("SELECT * FROM recordings WHERE id = ?").get(id) as any;
    if (!recording) return res.status(404).json({ error: "Recording not found" });
    const existing = conversionJobs.get(id);
    if (!(existing?.resultPromise && !existing.error && existing.progress < 100)) {
      const audioFilename = `${uuidv4()}.mp3`;
      beginConversion(id, path.join(uploadDir, recording.filename), audioFilename, () => {
        db.prepare("UPDATE recordings SET transcription_filename = ? WHERE id = ?").run(audioFilename, id);
      }).catch((err) => console.error("On-demand conversion failed:", err));
    }
    res.json({ success: true, jobId: id });
  });

  app.get("/api/recordings/:id/convert/progress", (req, res) => {
    const payload = conversionProgressPayload(req.params.id);
    res.status(payload.status).json(payload.body);
  });

  app.post("/api/upload", upload.single("file"), async (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { filename, originalname, mimetype, size, path: filePath } = req.file;
    const isVideo = mimetype.startsWith("video/");
    const isWav = mimetype === "audio/wav" || mimetype === "audio/x-wav" || originalname.toLowerCase().endsWith(".wav");
    if (isVideo || isWav) {
      const audioFilename = `${uuidv4()}.mp3`;
      const jobId = uuidv4();
      beginConversion(jobId, filePath, audioFilename).catch((err) => console.error("Background upload conversion failed:", err));
      return res.json({ filename, transcriptionFilename: audioFilename, originalname, mimetype, size, status: "converting", jobId });
    }
    res.json({ filename, transcriptionFilename: filename, originalname, mimetype, size, status: "ready" });
  });

  app.get("/api/jobs/:id/progress", (req, res) => {
    const payload = conversionProgressPayload(req.params.id);
    res.status(payload.status).json(payload.body);
  });

  app.get("/api/recordings/:id", (req, res) => {
    const recording = db.prepare(`SELECT ${RECORDING_META_SQL} FROM recordings WHERE id = ?`).get(req.params.id);
    if (!recording) return res.status(404).json({ error: "Recording not found" });
    res.json(recordingMeta(recording));
  });

  app.get("/api/recordings/:id/utterances", (req, res) => {
    const transcript = readStoredTranscript(req.params.id);
    const all = Array.isArray(transcript?.utterances) ? transcript.utterances : [];
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const includeWords = req.query.words !== "0";
    const utterances = all.slice(offset, offset + limit).map((utterance: any) => ({
      speaker: utterance.speaker,
      text: utterance.text,
      start: utterance.start,
      end: utterance.end,
      words: includeWords ? (utterance.words || []).map((word: any) => ({
        text: word.text,
        start: word.start,
        end: word.end,
        confidence: word.confidence,
        speaker: word.speaker,
      })) : undefined,
    }));
    res.json({ total: all.length, offset, utterances, transcriptId: transcript?.id || null });
  });

  app.get("/api/recordings/:id/speakers", (req, res) => {
    const transcript = readStoredTranscript(req.params.id);
    if (!transcript) return res.status(404).json({ error: "Transcript not found" });
    res.json({
      speakers: listSpeakers(transcript),
      suggestions: suggestSpeakerNames(transcript),
    });
  });

  app.get("/api/recordings/:id/transcript-search", (req, res) => {
    const query = String(req.query.q || "").trim().slice(0, 200).toLowerCase();
    if (!query) return res.json({ count: 0 });
    const transcript = readStoredTranscript(req.params.id);
    let count = 0;
    for (const utterance of transcript?.utterances || []) {
      const text = String(utterance?.text || "").toLowerCase();
      let from = 0;
      while (from < text.length) {
        const at = text.indexOf(query, from);
        if (at < 0) break;
        count += 1;
        from = at + Math.max(1, query.length);
      }
    }
    res.json({ count });
  });

  app.patch("/api/recordings/:id/utterances/:index", (req, res) => {
    const transcript = readStoredTranscript(req.params.id);
    if (!transcript?.utterances) return res.status(404).json({ error: "Transcript not found" });
    const index = Number(req.params.index);
    const utterance = transcript.utterances[index];
    if (!utterance) return res.status(404).json({ error: "Utterance not found" });
    const text = String(req.body?.text || "");
    utterance.text = text;
    const start = Number(utterance.start) || 0;
    const end = Math.max(start + 1, Number(utterance.end) || start + 1);
    const parts = text.split(/\s+/).filter(Boolean);
    utterance.words = parts.map((part: string, partIndex: number) => ({
      text: part,
      start: Math.round(start + ((end - start) * partIndex) / Math.max(1, parts.length)),
      end: Math.round(start + ((end - start) * (partIndex + 1)) / Math.max(1, parts.length)),
      confidence: 0.9,
      speaker: utterance.speaker,
    }));
    db.prepare("UPDATE recordings SET transcript = ? WHERE id = ?").run(JSON.stringify(transcript), req.params.id);
    res.json({ utterance });
  });

  app.delete("/api/cases/:id", (req, res) => {
    const result = db.prepare("DELETE FROM cases WHERE id = ?").run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: "Case not found" });
    res.json({ success: true });
  });

  app.patch("/api/recordings/:id", (req, res) => {
    const { transcript, summary, apod_results, speaker_labels, interview_type, report_meta, aai_deleted_at } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (transcript !== undefined) { updates.push("transcript = ?"); params.push(JSON.stringify(transcript)); }
    if (summary !== undefined) { updates.push("summary = ?"); params.push(summary); }
    if (apod_results !== undefined) { updates.push("apod_results = ?"); params.push(JSON.stringify(apod_results)); }
    if (speaker_labels !== undefined) { updates.push("speaker_labels = ?"); params.push(JSON.stringify(speaker_labels)); }
    if (interview_type !== undefined) { updates.push("interview_type = ?"); params.push(interview_type); }
    if (report_meta !== undefined) { updates.push("report_meta = ?"); params.push(JSON.stringify(report_meta)); }
    if (aai_deleted_at !== undefined) { updates.push("aai_deleted_at = ?"); params.push(aai_deleted_at); }
    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });
    params.push(req.params.id);
    db.prepare(`UPDATE recordings SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    res.json({ success: true });
  });

  app.post("/api/aai/transcribe-jobs", (req, res) => {
    if (!secrets.assemblyai) return res.status(400).json({ error: "AssemblyAI API key is not configured." });
    const jobId = uuidv4();
    const job: Job = { status: "running", progress: 5, message: "Opening the audio file…" };
    trackJob(jobId, job);
    res.json({ jobId });

    (async () => {
      const settings = getSettings();
      job.message = "Preparing speech audio…";
      job.progress = 8;
      const { filePath, recordingId } = await resolveAudioForTranscription(req.body || {});
      job.message = "Uploading audio to AssemblyAI…";
      job.progress = 15;
      const uploadUrl = await streamUploadAudio({
        filePath,
        apiKey: secrets.assemblyai,
        apiBase: resolveApiBase(settings),
        onProgress: ({ loaded, total, attempt, attempts }) => {
          const ratio = total > 0 ? Math.min(1, loaded / total) : 0;
          const pct = Math.round(ratio * 100);
          job.progress = 15 + Math.round(ratio * 20);
          const retryNote = attempt > 1 ? ` (attempt ${attempt}/${attempts})` : "";
          job.message = `Uploading audio to AssemblyAI… ${pct}%${retryNote}`;
        },
        onRetry: ({ nextAttempt, attempts, reason }) => {
          job.message = `Upload failed (${reason}). Retrying ${nextAttempt}/${attempts}…`;
          console.error(`[aai] ${job.message}`);
        },
      });
      job.message = "Starting transcription…";
      job.progress = 35;
      const request = buildTranscriptRequest({
        audioUrl: uploadUrl,
        speakersExpected: Number(req.body?.speakersExpected) || undefined,
        keyterms: Array.isArray(req.body?.keyterms) ? req.body.keyterms : undefined,
        includeBuiltinSummary: req.body?.includeBuiltinSummary === true,
      });
      const started = await createTranscript({
        apiKey: secrets.assemblyai,
        apiBase: resolveApiBase(settings),
        request,
      });
      job.transcriptId = started.id;
      job.message = "Transcribing…";
      job.progress = 45;
      const transcript = await pollWithBackoff({
        initialDelayMs: 3000,
        maxDelayMs: 20000,
        timeoutMs: 3 * 60 * 60 * 1000,
        poll: () => getTranscript({
          apiKey: secrets.assemblyai,
          apiBase: resolveApiBase(settings),
          transcriptId: started.id,
        }),
        isDone: (value) => value.status === "completed" || value.status === "error",
        onUpdate: (value) => {
          job.message = `Transcribing (${value.status || "processing"})…`;
          job.progress = Math.min(90, (job.progress || 45) + 2);
        },
      });
      if (transcript.status === "error") throw new Error(transcript.error || "AssemblyAI transcription failed");
      if (recordingId) {
        db.prepare("UPDATE recordings SET transcript = ? WHERE id = ?").run(JSON.stringify(transcript), recordingId);
      } else {
        job.transcript = transcript;
      }
      job.status = "completed";
      job.progress = 100;
      job.message = "Transcription saved locally";
      job.transcriptId = transcript.id || started.id;
    })().catch((error: any) => {
      const message = error?.message || "Transcription failed";
      const diagnostic = formatCauseChain(error);
      const stored = diagnostic ? `${message} [${diagnostic}]` : message;
      console.error("[aai] transcription job failed:", stored);
      if (error?.cause) {
        console.error("[aai] cause:", error.cause?.code || error.cause?.name || "", error.cause?.message || error.cause);
      }
      job.status = "error";
      job.error = stored;
      job.message = message;
    });
  });

  app.get("/api/aai/transcribe-jobs/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(publicJob(job));
  });

  app.post("/api/aai/transcribe-jobs/:jobId/release", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    job.transcript = undefined;
    res.json({ ok: true });
  });

  app.post("/api/keywords/search", (req, res) => {
    const job = jobs.get(String(req.body?.transcriptJobId || ""));
    if (!job?.transcript) return res.status(404).json({ error: "That transcription is no longer in memory." });
    const transcript = job.transcript;
    job.transcript = undefined;
    const matches = keywordHits(transcript.words || [], Array.isArray(req.body?.keywords) ? req.body.keywords : []);
    res.json({ matches, transcriptId: transcript.id || job.transcriptId || null });
  });

  app.post("/api/reports/jobs", (req, res) => {
    const settings = getSettings();
    const engine = req.body?.engine === "gemini" ? "gemini" : "gateway";
    const strictlyAssembly = req.body?.strictlyAssembly === true;
    if (engine === "gemini" && (!settings.allowGemini || strictlyAssembly)) {
      return res.status(403).json({
        error: "Google Gemini is turned off for case data. Nothing was sent to Google. Retry the AssemblyAI report, or enable Gemini in Settings only if your policy allows it.",
        code: "GEMINI_DISABLED",
      });
    }
    if (engine === "gateway" && !secrets.assemblyai) {
      return res.status(400).json({ error: "AssemblyAI API key is not configured." });
    }
    if (engine === "gemini" && !secrets.gemini) {
      return res.status(400).json({ error: "Gemini API key is not configured." });
    }
    if (!req.body?.reportType || !(req.body?.transcript || req.body?.recordingId || req.body?.transcriptJobId)) {
      return res.status(400).json({ error: "A report type and transcript are required." });
    }

    const jobId = uuidv4();
    const job: Job = { status: "running", progress: 5, message: "Starting the report…" };
    trackJob(jobId, job);
    res.json({ jobId });

    (async () => {
      let transcript = req.body.transcript;
      if (req.body.recordingId) transcript = readStoredTranscript(String(req.body.recordingId));
      if (req.body.transcriptJobId) {
        const source = jobs.get(String(req.body.transcriptJobId));
        if (!source?.transcript) throw new Error("That transcription is no longer in memory. Run it again.");
        transcript = source.transcript;
        source.transcript = undefined;
      }
      if (!transcript) throw new Error("Transcript text not found.");
      const model = normalizeModelId(req.body.model);
      const chat = engine === "gemini" ? geminiFor() : gatewayFor(model);
      const generated = await generateInvestigativeReport({
        reportType: req.body.reportType,
        customInstructions: req.body.customInstructions,
        transcript,
        speakerLabels: req.body.speakerLabels,
        caseInfo: req.body.caseInfo,
        model,
        tokenLimit: settings.chunkTokenLimit,
        engine: engine === "gemini" ? "gemini" : "assemblyai-gateway",
        chat,
        onProgress: (message, completed, total) => {
          job.message = message;
          job.progress = total > 0 ? Math.round((completed / total) * 100) : job.progress;
        },
      });
      const generatedAt = new Date().toISOString();
      const acknowledgedAt = acknowledgementIso(req.body?.aiAcknowledgedAt);
      const meta = {
        engine: generated.engine,
        model: generated.model,
        requestId: generated.requestId,
        transcriptId: generated.transcriptId,
        generatedAt,
        truncated: generated.truncated,
        partCount: generated.partCount,
        aiAcknowledgedAt: acknowledgedAt,
        aiAcknowledgedLabel: acknowledgedAt ? formatAiAcknowledgement(acknowledgedAt) : null,
      };
      if (req.body.recordingId) {
        db.prepare("UPDATE recordings SET summary = ?, interview_type = ?, report_meta = ? WHERE id = ?")
          .run(generated.text, req.body.reportType || null, JSON.stringify(meta), String(req.body.recordingId));
      }
      job.status = "completed";
      job.progress = 100;
      job.message = "Report ready";
      job.result = {
        response: generated.text,
        model: generated.model,
        requestId: generated.requestId,
        transcriptId: generated.transcriptId,
        truncated: generated.truncated,
        engine: generated.engine,
        generatedAt,
        partCount: generated.partCount,
        aiAcknowledgedAt: meta.aiAcknowledgedAt,
        aiAcknowledgedLabel: meta.aiAcknowledgedLabel,
        saved: Boolean(req.body.recordingId),
      };
    })().catch((error: any) => {
      console.error("[report] job failed:", error?.message || error);
      job.status = "error";
      job.error = error?.message || "Report generation failed";
      job.message = job.error;
    });
  });

  app.get("/api/reports/jobs/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(publicJob(job));
  });

  app.post("/api/apod", async (req, res) => {
    const settings = getSettings();
    if (!settings.allowGemini || req.body?.strictlyAssembly === true) {
      return res.status(403).json({
        error: "APOD uses Google Gemini, which is turned off. Nothing was sent to Google.",
        code: "GEMINI_DISABLED",
      });
    }
    if (!secrets.gemini) return res.status(400).json({ error: "Gemini API key is not configured." });
    try {
      const stored = req.body.recordingId ? readStoredTranscript(String(req.body.recordingId)) : null;
      const transcriptBlock = stored
        ? formatTranscriptForLLM(stored, req.body.speakerLabels)
        : typeof req.body.transcript === "string"
          ? req.body.transcript
          : formatTranscriptForLLM(req.body.transcript, req.body.speakerLabels);
      const prompts = apodUserPrompt(transcriptBlock);
      const result = await geminiGenerateContent({
        apiKey: secrets.gemini,
        system: prompts.system,
        user: prompts.user,
        maxOutputTokens: 16384,
        json: true,
      });
      res.json({ results: JSON.parse(result.text || "[]"), model: result.model || GEMINI_MODEL_ID });
    } catch (error: any) {
      console.error("[apod] failed:", error?.message || error);
      res.status(500).json({ error: error.message || "APOD analysis failed" });
    }
  });

  app.delete("/api/aai/transcripts/:id", async (req, res) => {
    const settings = getSettings();
    const transcriptId = req.params.id;
    const recordingId = req.body?.recordingId || req.query.recordingId;
    if (!settings.deleteRemoteTranscripts) {
      console.log(`[aai] DELETE skipped by setting transcript=${transcriptId}`);
      return res.json({ ok: true, skipped: true, deletedAt: null });
    }
    if (String(transcriptId).startsWith("local-whisper-")) {
      return res.json({ ok: true, skipped: true, deletedAt: null });
    }
    if (!secrets.assemblyai) return res.status(400).json({ error: "AssemblyAI API key is not configured." });
    const deletedAt = new Date().toISOString();
    try {
      const result = await deleteRemoteTranscript({
        apiKey: secrets.assemblyai,
        apiBase: resolveApiBase(settings),
        transcriptId,
      });
      db.prepare("INSERT INTO aai_deletion_log (transcript_id, recording_id, deleted_at, success, detail) VALUES (?, ?, ?, ?, ?)").run(
        transcriptId,
        recordingId || null,
        deletedAt,
        result.ok ? 1 : 0,
        result.detail
      );
      if (result.ok && recordingId) {
        db.prepare("UPDATE recordings SET aai_deleted_at = ? WHERE id = ?").run(deletedAt, recordingId);
      }
      if (!result.ok) return res.status(502).json({ ok: false, deletedAt: null, error: result.detail });
      res.json({ ok: true, deletedAt });
    } catch (error: any) {
      console.error(`[aai] DELETE failed transcript=${transcriptId}:`, error?.message || error);
      db.prepare("INSERT INTO aai_deletion_log (transcript_id, recording_id, deleted_at, success, detail) VALUES (?, ?, ?, ?, ?)").run(
        transcriptId,
        recordingId || null,
        deletedAt,
        0,
        error?.message || "delete failed"
      );
      res.status(502).json({ ok: false, deletedAt: null, error: error.message || "Delete failed" });
    }
  });

  app.post("/api/maintenance/clean-reports", (_req, res) => {
    try {
      const backupPath = backupDatabase();
      const recordings = db.prepare("SELECT id, summary FROM recordings WHERE summary IS NOT NULL AND trim(summary) != ''").all() as any[];
      const timelines = db.prepare("SELECT id, timeline_report FROM cases WHERE timeline_report IS NOT NULL AND trim(timeline_report) != ''").all() as any[];
      let recordingsChanged = 0;
      let timelinesChanged = 0;
      const updateRecording = db.prepare("UPDATE recordings SET summary = ? WHERE id = ?");
      const updateTimeline = db.prepare("UPDATE cases SET timeline_report = ? WHERE id = ?");
      const tx = db.transaction(() => {
        for (const row of recordings) {
          const cleaned = cleanStoredText(row.summary, "report");
          if (cleaned.changed) {
            updateRecording.run(cleaned.text, row.id);
            recordingsChanged += 1;
          }
        }
        for (const row of timelines) {
          const cleaned = cleanStoredText(row.timeline_report, "timeline");
          if (cleaned.changed) {
            updateTimeline.run(cleaned.text, row.id);
            timelinesChanged += 1;
          }
        }
      });
      tx();
      res.json({
        backupPath,
        recordingsExamined: recordings.length,
        recordingsChanged,
        timelinesExamined: timelines.length,
        timelinesChanged,
      });
    } catch (error: any) {
      console.error("[clean] failed:", error);
      res.status(500).json({ error: error.message || "Clean failed" });
    }
  });

  // Compatibility route. The key is read from the main process, never from the body.
  app.post("/api/lemur", async (req, res) => {
    if (req.body?.apiKey || req.body?.geminiKey) {
      console.warn("[lemur] Ignored API key fields on the request body.");
    }
    if (!secrets.assemblyai) return res.status(400).json({ error: "AssemblyAI API key is not configured." });
    const { transcriptId, transcript, reportType, customInstructions, speakerLabels, caseInfo, model } = req.body || {};
    if (!reportType || (!transcript && !transcriptId)) {
      return res.status(400).json({ error: "Missing reportType and transcript." });
    }
    try {
      let source = transcript;
      if (!source && transcriptId) {
        source = await getTranscript({
          apiKey: secrets.assemblyai,
          apiBase: resolveApiBase(),
          transcriptId,
        });
      }
      const selected = normalizeModelId(model);
      const generated = await generateInvestigativeReport({
        reportType,
        customInstructions,
        transcript: source,
        speakerLabels,
        caseInfo,
        model: selected,
        tokenLimit: getSettings().chunkTokenLimit,
        chat: gatewayFor(selected),
      });
      res.json({
        response: generated.text,
        model: generated.model,
        requestId: generated.requestId,
        truncated: generated.truncated,
      });
    } catch (e: any) {
      console.error("LLM Gateway request failed:", e?.message || e);
      res.status(500).json({ error: e.message || "LLM Gateway request failed" });
    }
  });

  app.post("/api/recordings/:id/transcribe-local", (req, res) => {
    const { id } = req.params;
    const recording = db.prepare("SELECT * FROM recordings WHERE id = ?").get(id) as any;
    if (!recording) return res.status(404).json({ error: "Recording not found" });
    if (!fs.existsSync(path.join(uploadDir, recording.filename))) {
      return res.status(404).json({ error: "Audio file not found for transcription." });
    }

    const jobId = uuidv4();
    const job: Job = { status: "running", progress: 1, message: "Preparing local transcription…" };
    trackJob(jobId, job);
    res.json({ jobId });

    (async () => {
      const tempDir = path.join(uploadDir, `whisper-${jobId}`);
      try {
        job.message = "Preparing speech audio…";
        const audioPath = await speechFileForRecording(recording);
        const durationMs = await probeDurationMs(audioPath);
        if (!durationMs) throw new Error("Could not read the recording length.");
        const plans = planWhisperSegments(durationMs);
        fs.mkdirSync(tempDir, { recursive: true });
        const { pipeline } = await import("@huggingface/transformers");
        console.log(`[WHISPER] ${plans.length} segment(s), ${Math.round(durationMs / 1000)}s`);
        const transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", { device: "cpu" });
        const pieces = [];
        for (const plan of plans) {
          job.message = `Segment ${plan.index + 1} of ${plans.length}`;
          job.progress = Math.max(1, Math.round((plan.index / plans.length) * 90));
          const wavPath = path.join(tempDir, `${plan.index}.wav`);
          await extractWavSegment(audioPath, wavPath, plan.startMs, Math.max(1, plan.endMs - plan.startMs));
          const audio = wavPcm16ToFloat32(fs.readFileSync(wavPath));
          try { fs.unlinkSync(wavPath); } catch (e) {}
          const result = await transcriber(audio, { return_timestamps: true }) as any;
          pieces.push({
            index: plan.index,
            startMs: plan.startMs,
            overlapMs: plan.overlapMs,
            chunks: (result.chunks || []).map((chunk: any) => ({
              text: String(chunk.text || ""),
              start: chunk.timestamp?.[0] || 0,
              end: chunk.timestamp?.[1] || chunk.timestamp?.[0] || 0,
            })),
          });
        }
        const stitched = stitchWhisperSegments(pieces);
        const transcriptId = `local-whisper-${uuidv4()}`;
        const completeTranscript = {
          text: stitched.text,
          id: transcriptId,
          status: "completed",
          words: stitched.words,
          utterances: stitched.utterances,
        };
        db.prepare("UPDATE recordings SET transcript = ? WHERE id = ?").run(JSON.stringify(completeTranscript), id);
        job.status = "completed";
        job.progress = 100;
        job.message = "Local transcription saved";
        job.transcriptId = transcriptId;
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    })().catch((error: any) => {
      console.error("Local Whisper transcription failed:", error?.message || error);
      logMemory("whisper-error");
      job.status = "error";
      job.error = error?.message || "Local transcription failed";
      job.message = job.error;
    });
  });

  async function respondImported(res: any, copied: { filename: string; originalname: string; mimetype: string; size: number; filePath: string }, caseId?: string) {
    const { filename, originalname, mimetype, size, filePath } = copied;
    const isVideo = mimetype.startsWith("video/");
    const isWav = mimetype === "audio/wav" || originalname.toLowerCase().endsWith(".wav");
    let transcriptionFilename = filename;
    let status = "ready";
    let jobId: string | undefined;
    if (isVideo || isWav) {
      transcriptionFilename = `${uuidv4()}.mp3`;
      jobId = uuidv4();
      status = "converting";
    }
    if (caseId) {
      const id = uuidv4();
      db.prepare(`
        INSERT INTO recordings (id, case_id, filename, transcription_filename, original_name, mime_type, size)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, caseId, filename, filename, originalname, mimetype, size);
      if (isVideo || isWav) {
        speechFileForRecording({
          id,
          filename,
          transcription_filename: filename,
          mime_type: mimetype,
          original_name: originalname,
        }, transcriptionFilename).catch((err) => console.error("Import conversion failed:", err));
      }
      return res.json({ id, filename, transcriptionFilename, originalname, mimetype, size, status });
    }
    if ((isVideo || isWav) && jobId) {
      beginConversion(jobId, filePath, transcriptionFilename).catch((err) => console.error("Import conversion failed:", err));
    }
    return res.json({ filename, transcriptionFilename, originalname, mimetype, size, status, jobId });
  }

  app.post("/api/cases/:id/recordings/import", async (req, res) => {
    try {
      const copied = await copyChosenMedia(String(req.body?.path || ""));
      await respondImported(res, copied, req.params.id);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message || "Import failed" });
    }
  });

  app.post("/api/upload/import", async (req, res) => {
    try {
      const copied = await copyChosenMedia(String(req.body?.path || ""));
      await respondImported(res, copied);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message || "Import failed" });
    }
  });

  app.post("/api/keys/test", async (req, res) => {
    const settings = getSettings();
    const service = req.body?.service === "gemini" ? "gemini" : req.body?.service === "assemblyai" ? "assemblyai" : "";
    if (!service) return res.status(400).json({ ok: false, message: "Choose AssemblyAI or Gemini." });
    if (service === "gemini" && !settings.allowGemini) {
      return res.json({ ok: false, message: "Gemini is turned off. Nothing was sent to Google." });
    }
    const result = service === "gemini"
      ? await testGeminiKey({ apiKey: secrets.gemini, model: GEMINI_MODEL_ID })
      : await testAssemblyAiKey({ apiBase: resolveApiBase(settings), apiKey: secrets.assemblyai });
    console.log(`[keys] ${service} test ok=${result.ok}`);
    res.json(result);
  });

  app.post("/api/maintenance/regress", async (_req, res) => {
    try {
      const result = await runRegression({ samplesDir: path.join(userDataPath, "regression-samples") });
      res.json(result);
    } catch (error: any) {
      logMemory("regress-error");
      res.status(500).json({ error: error.message || "Sample check failed" });
    }
  });

  app.use("/uploads", express.static(uploadDir));

  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("Server Error:", err);
    logMemory("request-error");
    res.status(err.status || 500).json({
      error: err.message || "Internal Server Error",
      details: process.env.NODE_ENV !== "production" ? err.stack : undefined,
    });
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const PORT = process.env.PORT || 3000;

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const appPath = process.env.APP_PATH || process.cwd();
    const distPath = path.join(appPath, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const host = "127.0.0.1";
  app.listen(Number(PORT), host, () => {
    console.log(`Server running on http://${host}:${PORT}`);
    logMemory("listen");
    const timer = setInterval(() => logMemory("interval"), 60_000);
    timer.unref?.();
    if (process.send) process.send({ type: "server-ready" });
  });
}

if (process.env.NARRATIVE_NO_AUTOSTART !== "1") {
  startServer();
}
