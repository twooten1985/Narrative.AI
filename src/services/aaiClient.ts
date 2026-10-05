import fs from "fs";
import { Transform } from "node:stream";
import { Agent, fetch as undiciFetch } from "undici";
import { DEFAULT_SPEECH_MODELS } from "./config";

/**
 * AssemblyAI /v2/upload sends response headers only after the whole body is
 * stored. Undici's default headersTimeout is 300s, so a slow mobile upload
 * dies as TypeError: fetch failed (cause UND_ERR_HEADERS_TIMEOUT) even while
 * bytes are still going out. These cover the existing 3-hour transcription
 * budget. Connect failures still fail fast so the retry loop can run.
 */
export const UPLOAD_MAX_ATTEMPTS = 4;
export const UPLOAD_HEADERS_TIMEOUT_MS = 3 * 60 * 60 * 1000;
export const UPLOAD_BODY_TIMEOUT_MS = 3 * 60 * 60 * 1000;
export const UPLOAD_CONNECT_TIMEOUT_MS = 30_000;

const TRANSIENT_UPLOAD_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNABORTED",
  "ENETRESET",
  "EHOSTDOWN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_REQUEST_ABORTED",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
  "UND_ERR_ABORTED",
]);

const FATAL_UPLOAD_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ERR_INVALID_ARG_TYPE"]);

export interface UploadProgress {
  loaded: number;
  total: number;
  attempt: number;
  attempts: number;
}

export interface UploadRetryInfo {
  nextAttempt: number;
  attempts: number;
  reason: string;
}

export function uploadDispatcherOptions() {
  return {
    headersTimeout: UPLOAD_HEADERS_TIMEOUT_MS,
    bodyTimeout: UPLOAD_BODY_TIMEOUT_MS,
    connectTimeout: UPLOAD_CONNECT_TIMEOUT_MS,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
  };
}

let uploadAgent: Agent | null = null;

export function getUploadAgent(): Agent {
  if (!uploadAgent) uploadAgent = new Agent(uploadDispatcherOptions());
  return uploadAgent;
}

interface ErrorInfo {
  codes: string[];
  messages: string[];
  status?: number;
}

function walkError(error: unknown): ErrorInfo {
  const codes: string[] = [];
  const messages: string[] = [];
  let status: number | undefined;
  const seen = new Set<unknown>();
  let current: any = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (typeof current.status === "number" && status === undefined) status = current.status;
    if (current.code && !codes.includes(String(current.code))) codes.push(String(current.code));
    if (typeof current.message === "string" && current.message.trim() && !messages.includes(current.message)) {
      messages.push(current.message);
    }
    current = current.cause;
  }
  return { codes, messages, status };
}

/** Compact code/cause text safe to store on a job and in the log. */
export function formatCauseChain(error: unknown): string {
  const info = walkError(error);
  const codes = [...info.codes];
  if (info.status && !codes.includes(`HTTP_${info.status}`)) codes.push(`HTTP_${info.status}`);
  const causeMessages = info.messages.slice(1);
  return [
    codes.length ? `code=${codes.join(",")}` : "",
    causeMessages.length ? `cause=${causeMessages.join(" | ")}` : "",
  ].filter(Boolean).join(" ");
}

export function isTransientUploadFailure(error: unknown): boolean {
  const info = walkError(error);
  if (info.status === 401 || info.status === 403 || info.status === 400 || info.status === 404 || info.status === 413) return false;
  if (info.codes.some((code) => FATAL_UPLOAD_CODES.has(code))) return false;
  if (info.status === 408 || info.status === 409 || info.status === 425 || info.status === 429) return true;
  if (typeof info.status === "number" && info.status >= 500 && info.status <= 599) return true;
  if (info.codes.some((code) => TRANSIENT_UPLOAD_CODES.has(code) || code.startsWith("UND_ERR_"))) return true;
  const text = info.messages.join(" ").toLowerCase();
  return (
    text.includes("fetch failed") ||
    text.includes("failed to fetch") ||
    text.includes("socket hang up") ||
    text.includes("network error") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("econnreset")
  );
}

function shortUploadReason(error: unknown): string {
  const info = walkError(error);
  if (info.status) return `HTTP ${info.status}`;
  if (info.codes[0]) return info.codes[0];
  return "network connection dropped";
}

export function uploadFailureMessage(error: unknown, attempt?: number, attempts?: number): string {
  const info = walkError(error);
  const attemptNote = attempt && attempts ? ` (attempt ${attempt}/${attempts})` : "";
  if (info.status === 401 || info.status === 403) {
    return `AssemblyAI rejected the API key. Open Settings and check the key, then retry. The recording is still on this computer.${attemptNote}`;
  }
  if (typeof info.status === "number" && (info.status === 429 || info.status >= 500)) {
    const detail = info.messages[info.messages.length - 1];
    const cleaned = detail && !detail.includes(`(${info.status})`) ? `: ${detail}` : "";
    return `AssemblyAI returned an error (${info.status}${cleaned}). The recording is still on this computer. Use Retry to send it again.${attemptNote}`;
  }
  if (isTransientUploadFailure(error)) {
    const detail = info.codes[0] || info.messages[info.messages.length - 1] || "network connection dropped";
    return `The upload to AssemblyAI was interrupted (${detail}). The recording is still on this computer. Use Retry to send it again.${attemptNote}`;
  }
  if (info.status) {
    const detail = info.messages[info.messages.length - 1];
    const cleaned = detail && !detail.includes(`(${info.status})`) ? `: ${detail}` : "";
    return `AssemblyAI rejected the upload (${info.status}${cleaned}).${attemptNote}`;
  }
  const fallback = info.messages[info.messages.length - 1] || "AssemblyAI upload failed.";
  return `${fallback}${attemptNote}`;
}

class UploadAttemptError extends Error {
  status?: number;
  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "UploadAttemptError";
    this.status = options?.status;
  }
}

function uploadBackoffMs(failedAttempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, failedAttempt - 1));
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

function destroyQuiet(stream: { destroyed?: boolean; destroy: (error?: Error) => any } | null | undefined) {
  if (!stream || stream.destroyed) return;
  stream.destroy();
}

function openUploadBody(
  filePath: string,
  openStream: (filePath: string) => fs.ReadStream,
  onBytes: (loaded: number) => void,
) {
  const source = openStream(filePath);
  let loaded = 0;
  const body = new Transform({
    transform(chunk, _encoding, callback) {
      loaded += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      try { onBytes(loaded); } catch { /* progress reporting must not fail the upload */ }
      callback(null, chunk);
    },
  });
  const fail = (error: Error) => {
    if (!body.destroyed) body.destroy(error);
  };
  source.on("error", fail);
  source.pipe(body);
  let closed = false;
  return {
    body,
    destroy() {
      if (closed) return;
      closed = true;
      source.removeListener("error", fail);
      source.on("error", () => {});
      body.on("error", () => {});
      destroyQuiet(source);
      destroyQuiet(body);
    },
  };
}

export interface TranscriptRequestOptions {
  audioUrl: string;
  speakersExpected?: number;
  keyterms?: string[];
  includeBuiltinSummary?: boolean;
}

/** Request body for POST /v2/transcript. Never sends word_boost. */
export function buildTranscriptRequest(opts: TranscriptRequestOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    audio_url: opts.audioUrl,
    speaker_labels: true,
    speech_models: [...DEFAULT_SPEECH_MODELS],
  };
  if (opts.speakersExpected && opts.speakersExpected > 0) {
    body.speakers_expected = Math.round(opts.speakersExpected);
  }
  const terms = (opts.keyterms || []).map((term) => term.trim()).filter(Boolean).slice(0, 200);
  if (terms.length > 0) body.keyterms_prompt = terms;
  // The built-in summarizer hangs on universal-3-5-pro and the reports use the
  // LLM Gateway instead. Attach it only when a caller will actually read it.
  if (opts.includeBuiltinSummary) {
    body.speech_understanding = {
      request: {
        summarization: {
          summary_type: "bullets",
          effort: "medium",
        },
      },
    };
  }
  return body;
}

export async function streamUploadAudio(opts: {
  filePath: string;
  apiKey: string;
  apiBase: string;
  fetchImpl?: FetchLike;
  maxAttempts?: number;
  openStream?: (filePath: string) => fs.ReadStream;
  sleepImpl?: (ms: number) => Promise<void>;
  dispatcher?: unknown;
  onProgress?: (progress: UploadProgress) => void;
  onRetry?: (info: UploadRetryInfo) => void;
}): Promise<string> {
  const attempts = Math.max(1, opts.maxAttempts ?? UPLOAD_MAX_ATTEMPTS);
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const openStream = opts.openStream ?? ((filePath: string) => fs.createReadStream(filePath));
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => undiciFetch(url, {
    ...init,
    dispatcher: (init.dispatcher as Agent | undefined) ?? getUploadAgent(),
  }) as unknown as ReturnType<FetchLike>);
  const endpoint = `${opts.apiBase.replace(/\/$/, "")}/v2/upload`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let opened: ReturnType<typeof openUploadBody> | null = null;
    try {
      const stat = await fs.promises.stat(opts.filePath);
      if (!stat.isFile() || stat.size <= 0) {
        throw new UploadAttemptError("The audio file is empty, so it was not uploaded.", { cause: Object.assign(new Error("empty file"), { code: "ENOENT" }) });
      }
      let lastTick = 0;
      opened = openUploadBody(opts.filePath, openStream, (loaded) => {
        const now = Date.now();
        if (loaded < stat.size && now - lastTick < 200) return;
        lastTick = now;
        opts.onProgress?.({ loaded, total: stat.size, attempt, attempts });
      });
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: opts.apiKey,
          "content-type": "application/octet-stream",
          "content-length": String(stat.size),
        },
        body: opened.body,
        duplex: "half",
        dispatcher: opts.dispatcher ?? (opts.fetchImpl ? undefined : getUploadAgent()),
      });
      const result = await response.json().catch(() => ({})) as { upload_url?: string; error?: string };
      if (!response.ok || !result.upload_url) {
        const message = result.error || `AssemblyAI upload failed (${response.status})`;
        throw new UploadAttemptError(message, { status: response.status });
      }
      return result.upload_url;
    } catch (error) {
      lastError = error;
      opened?.destroy();
      opened = null;
      const transient = isTransientUploadFailure(error);
      console.error(`[aai] upload attempt ${attempt}/${attempts} failed: ${uploadFailureMessage(error)} [${formatCauseChain(error) || "no-cause"}]`);
      if (!transient || attempt === attempts) {
        const wrapped = new Error(uploadFailureMessage(error, attempt, attempts));
        (wrapped as Error & { cause?: unknown; status?: number }).cause = error;
        const status = walkError(error).status;
        if (status) (wrapped as Error & { status?: number }).status = status;
        throw wrapped;
      }
      opts.onRetry?.({
        nextAttempt: attempt + 1,
        attempts,
        reason: shortUploadReason(error),
      });
      await sleep(uploadBackoffMs(attempt));
    } finally {
      opened?.destroy();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("AssemblyAI upload failed.");
}

export async function createTranscript(opts: {
  apiKey: string;
  apiBase: string;
  request: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; raw: any }> {
  const fetchImpl = opts.fetchImpl || fetch;
  const response = await fetchImpl(`${opts.apiBase.replace(/\/$/, "")}/v2/transcript`, {
    method: "POST",
    headers: {
      authorization: opts.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(opts.request),
  });
  const result = await response.json().catch(() => ({})) as any;
  if (!response.ok || !result.id) {
    throw new Error(result.error || `AssemblyAI transcription failed to start (${response.status})`);
  }
  return { id: result.id, raw: result };
}

export async function getTranscript(opts: {
  apiKey: string;
  apiBase: string;
  transcriptId: string;
  fetchImpl?: typeof fetch;
}): Promise<any> {
  const fetchImpl = opts.fetchImpl || fetch;
  const response = await fetchImpl(`${opts.apiBase.replace(/\/$/, "")}/v2/transcript/${opts.transcriptId}`, {
    headers: { authorization: opts.apiKey },
  });
  const result = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    throw new Error(result.error || `AssemblyAI transcript poll failed (${response.status})`);
  }
  return result;
}

export async function deleteRemoteTranscript(opts: {
  apiKey: string;
  apiBase: string;
  transcriptId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number; detail: string }> {
  const fetchImpl = opts.fetchImpl || fetch;
  const response = await fetchImpl(`${opts.apiBase.replace(/\/$/, "")}/v2/transcript/${opts.transcriptId}`, {
    method: "DELETE",
    headers: { authorization: opts.apiKey },
  });
  const ok = response.ok || response.status === 404;
  let detail = ok ? "deleted" : `HTTP ${response.status}`;
  if (!ok) {
    const body = await response.text().catch(() => "");
    if (body) detail = body.slice(0, 300);
  }
  console.log(`[aai] DELETE /v2/transcript/${opts.transcriptId} status=${response.status} ok=${ok}`);
  return { ok, status: response.status, detail };
}
