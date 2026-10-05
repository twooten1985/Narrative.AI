import { apiFetch } from "./apiClient";
import { pollWithBackoff } from "./polling";
import type { CaseInfo } from "./reportPrompts";

const TRANSCRIBE_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const REPORT_TIMEOUT_MS = 45 * 60 * 1000;

export interface ReportJobResult {
  response: string;
  model: string | null;
  requestId: string | null;
  transcriptId: string | null;
  truncated: boolean;
  engine: string;
  generatedAt: string;
}

export async function transcribeOnServer(opts: {
  recordingId?: string;
  filename?: string;
  speakersExpected?: number;
  keyterms?: string[];
  includeBuiltinSummary?: boolean;
  onProgress?: (message: string, progress: number) => void;
}): Promise<{ jobId: string; transcriptId: string }> {
  const started = await apiFetch("/api/aai/transcribe-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recordingId: opts.recordingId,
      filename: opts.filename,
      speakersExpected: opts.speakersExpected,
      keyterms: opts.keyterms,
      includeBuiltinSummary: opts.includeBuiltinSummary === true,
    }),
  });

  let lastProgress = 10;
  const job = await pollWithBackoff({
    initialDelayMs: 2000,
    maxDelayMs: 15000,
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    poll: () => apiFetch(`/api/aai/transcribe-jobs/${started.jobId}`),
    isDone: (value) => value.status === "completed" || value.status === "error",
    onUpdate: (value) => {
      lastProgress = Number(value.progress) || lastProgress;
      opts.onProgress?.(value.message || "Transcribing…", lastProgress);
    },
    onTransientError: (_error, attempt, maxAttempts) => {
      opts.onProgress?.(`Reconnecting to the local server (${attempt}/${maxAttempts})…`, lastProgress);
    },
  });

  if (job.status === "error") throw new Error(job.error || "Transcription failed");
  return { jobId: started.jobId, transcriptId: job.transcriptId };
}

export async function transcribeLocally(opts: {
  recordingId: string;
  onProgress?: (message: string, progress: number) => void;
}): Promise<{ transcriptId: string }> {
  const started = await apiFetch(`/api/recordings/${opts.recordingId}/transcribe-local`, { method: "POST" });
  let lastProgress = 10;
  const job = await pollWithBackoff({
    initialDelayMs: 1000,
    maxDelayMs: 8000,
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    poll: () => apiFetch(`/api/aai/transcribe-jobs/${started.jobId}`),
    isDone: (value) => value.status === "completed" || value.status === "error",
    onUpdate: (value) => {
      lastProgress = Number(value.progress) || lastProgress;
      opts.onProgress?.(value.message || "Transcribing locally…", lastProgress);
    },
    onTransientError: (_error, attempt, maxAttempts) => {
      opts.onProgress?.(`Reconnecting to the local server (${attempt}/${maxAttempts})…`, lastProgress);
    },
  });
  if (job.status === "error") throw new Error(job.error || "Local transcription failed");
  return { transcriptId: job.transcriptId };
}

export async function generateReportOnServer(opts: {
  transcript?: any;
  recordingId?: string;
  transcriptJobId?: string;
  reportType: string;
  customInstructions?: string;
  speakerLabels?: Record<string, string>;
  caseInfo?: CaseInfo;
  model?: string;
  engine?: "gateway" | "gemini";
  strictlyAssembly?: boolean;
  onProgress?: (message: string) => void;
}): Promise<ReportJobResult> {
  const started = await apiFetch("/api/reports/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript: opts.transcript,
      recordingId: opts.recordingId,
      transcriptJobId: opts.transcriptJobId,
      reportType: opts.reportType,
      customInstructions: opts.customInstructions,
      speakerLabels: opts.speakerLabels,
      caseInfo: opts.caseInfo,
      model: opts.model,
      engine: opts.engine || "gateway",
      strictlyAssembly: opts.strictlyAssembly === true,
    }),
  });

  const job = await pollWithBackoff({
    initialDelayMs: 1500,
    maxDelayMs: 8000,
    timeoutMs: REPORT_TIMEOUT_MS,
    poll: () => apiFetch(`/api/reports/jobs/${started.jobId}`),
    isDone: (value) => value.status === "completed" || value.status === "error",
    onUpdate: (value) => opts.onProgress?.(value.message || "Writing the report…"),
    onTransientError: (_error, attempt, maxAttempts) => {
      opts.onProgress?.(`Reconnecting to the local server (${attempt}/${maxAttempts})…`);
    },
  });

  if (job.status === "error") throw new Error(job.error || "Report generation failed");
  return job.result as ReportJobResult;
}

export async function releaseTranscriptJob(jobId: string): Promise<void> {
  await apiFetch(`/api/aai/transcribe-jobs/${encodeURIComponent(jobId)}/release`, { method: "POST" });
}

export async function searchKeywords(transcriptJobId: string, keywords: string[]): Promise<{
  matches: { keyword: string; context: string; start: string; confidence: number }[];
  transcriptId: string | null;
}> {
  return apiFetch("/api/keywords/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcriptJobId, keywords }),
  });
}

export async function deleteRemoteTranscript(transcriptId: string, recordingId?: string): Promise<{
  ok: boolean;
  deletedAt: string | null;
  skipped?: boolean;
  error?: string;
}> {
  return apiFetch(`/api/aai/transcripts/${encodeURIComponent(transcriptId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recordingId }),
  });
}
