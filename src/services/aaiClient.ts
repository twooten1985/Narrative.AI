import fs from "fs";
import { DEFAULT_SPEECH_MODELS } from "./config";

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
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl || fetch;
  const stat = fs.statSync(opts.filePath);
  const stream = fs.createReadStream(opts.filePath);
  const response = await fetchImpl(`${opts.apiBase.replace(/\/$/, "")}/v2/upload`, {
    method: "POST",
    headers: {
      authorization: opts.apiKey,
      "content-type": "application/octet-stream",
      "content-length": String(stat.size),
    },
    body: stream as unknown as BodyInit,
    duplex: "half",
  } as RequestInit);
  const result = await response.json().catch(() => ({})) as { upload_url?: string; error?: string };
  if (!response.ok || !result.upload_url) {
    throw new Error(result.error || `AssemblyAI upload failed (${response.status})`);
  }
  return result.upload_url;
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
