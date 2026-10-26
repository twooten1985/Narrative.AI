import { buildChunkMessages, buildMergeMessages, buildReportMessages } from "./reportPrompts";
import {
  completeWithContinuation,
  groupMergeItems,
  isTruncatedFinish,
  maxTokensFor,
  visibleOutputBudget,
  type CallKind,
  type ChatFn,
  type ChatMessage,
  type ChatResult,
  type MergeItem,
} from "./reportCompletion";
import { chunkTranscript, type TranscriptChunk } from "./transcriptChunks";
import type { CaseInfo } from "./reportPrompts";
import { listSpeakers, suggestSpeakerNames, type SpeakerSuggestion } from "./speakerNames";
import { estimateTokens } from "./transcriptChunks";
import { isGatewayError } from "./gatewayErrors";
import { findGenderedPronouns, segmentUtterances, sortUnclearAudio, verifyTimestamps, type PronounCheck, type TimestampCheckResult } from "./timestamps";

export type { ChatFn, ChatMessage, ChatResult };
export { isTruncatedFinish };

export const TRUNCATION_WARNING =
  "> **Warning:** This report reached the model's length limit and may be incomplete. Verify it against the original recording.";

export interface GenerateReportOptions {
  reportType: string;
  transcript: { text?: string | null; utterances?: any[] | null; id?: string | null };
  speakerLabels?: Record<string, string> | null;
  /** Optional override. When omitted, names are taken from quotes in the transcript. */
  speakerSuggestions?: SpeakerSuggestion[];
  caseInfo?: CaseInfo;
  customInstructions?: string;
  model: string;
  tokenLimit?: number;
  /** Test override for how much text one merge call is asked to rewrite. */
  outputBudgetTokens?: number;
  chat: ChatFn;
  onProgress?: (message: string, completed: number, total: number) => void;
  /** Finished chunk summaries are saved here so a retry resumes at the failed chunk. */
  partialStore?: PartialStore;
  /** Stops between calls. A call that is already running is stopped by the caller's own signal. */
  signal?: AbortSignal;
  /** Called after each chunk summary is saved. */
  onPartialSaved?: (saved: number, total: number) => void;
}

export interface PartialStore {
  get(key: string): MergeItem[] | null;
  set(key: string, items: MergeItem[]): void;
}

export function createMemoryPartialStore(): PartialStore & { entries: Map<string, MergeItem[]> } {
  const entries = new Map<string, MergeItem[]>();
  return { entries, get: (key) => entries.get(key) ?? null, set: (key, items) => { entries.set(key, items); } };
}

/** Small non-cryptographic string hash. It only keys saved parts for one recording. */
export function hashKey(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function splitChunkInHalf(chunk: TranscriptChunk): [TranscriptChunk, TranscriptChunk] | null {
  const lines = chunk.text.split("\n");
  if (lines.length < 2) return null;
  const half = chunk.text.length / 2;
  let used = 0;
  let cut = 1;
  for (let i = 0; i < lines.length - 1; i++) {
    used += lines[i].length + 1;
    cut = i + 1;
    if (used >= half) break;
  }
  const make = (part: string[], index: number, label: string): TranscriptChunk => {
    const text = part.join("\n");
    return { index, startMs: chunk.startMs, endMs: chunk.endMs, text, utteranceCount: part.length, estimatedTokens: estimateTokens(text), rangeLabel: label };
  };
  return [
    make(lines.slice(0, cut), chunk.index, `${chunk.rangeLabel} (first half)`),
    make(lines.slice(cut), chunk.index, `${chunk.rangeLabel} (second half)`),
  ];
}

export interface GeneratedReport {
  text: string;
  /** Chunk summaries reused from an earlier attempt. */
  resumedParts?: number;
  /** Times a too-large request was split in half. */
  sizeSplits?: number;
  model: string;
  requestId: string | null;
  transcriptId: string | null;
  truncated: boolean;
  engine: "assemblyai-gateway" | "gemini" | "local";
  partCount: number;
  /** Result of checking every cited [hh:mm:ss] against the transcript. */
  timestampCheck?: TimestampCheck;
  /** Gendered pronouns found outside quotes in the finished report (a warning, not a block). */
  pronounCheck?: PronounCheck;
}

export type TimestampCheck = Pick<TimestampCheckResult, "cited" | "verified" | "corrected" | "unverified" | "changes" | "flagged">;

export function withTruncationWarning(text: string, truncated: boolean): string {
  if (!truncated) return text;
  if (text.includes("reached the model's length limit")) return text;
  return `${text}\n\n${TRUNCATION_WARNING}`;
}

function stripTruncationNote(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.includes("reached the model's length limit"))
    .join("\n")
    .trim();
}

async function completePart(
  chat: ChatFn,
  model: string,
  messages: Parameters<typeof completeWithContinuation>[0]["messages"],
  sizing: { kind: CallKind; inputTokens: number; scale?: number }
) {
  return completeWithContinuation({
    chat,
    model,
    messages,
    maxTokens: maxTokensFor({ model, kind: sizing.kind, inputTokens: sizing.inputTokens, scale: sizing.scale }),
  });
}

function isSizeError(error: unknown): boolean {
  return isGatewayError(error) && error.kind === "size";
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error: any = new Error("Stopped by the user.");
    error.name = "AbortError";
    throw error;
  }
}

export async function generateInvestigativeReport(opts: GenerateReportOptions & { engine?: GeneratedReport["engine"] }): Promise<GeneratedReport> {
  const engine = opts.engine || "assemblyai-gateway";
  const speakers = listSpeakers(opts.transcript);
  const speakerSuggestions = opts.speakerSuggestions ?? suggestSpeakerNames(opts.transcript);
  const speakerContext = {
    speakerLabels: opts.speakerLabels,
    speakerSuggestions,
    speakers,
  };
  const chunks = chunkTranscript(opts.transcript, opts.speakerLabels, { tokenLimit: opts.tokenLimit });
  if (chunks.length === 0) {
    throw new Error("Transcript text not found.");
  }

  const transcriptId = opts.transcript?.id || null;
  const store = opts.partialStore;
  let truncated = false;
  let model = opts.model;
  let requestId: string | null = null;
  let resumedParts = 0;
  let sizeSplits = 0;
  let savedParts = 0;
  /** After the service says a request is too large, bigger pieces are split before they are sent. */
  let pieceLimitTokens = Number.POSITIVE_INFINITY;
  let mergeScale = 1;

  interface PieceResult {
    items: MergeItem[];
    /** Set when the piece was written as the whole report in one call. */
    whole: boolean;
  }

  const keyFor = (built: { system: string; user: string }, partIndex: number, partCount: number) =>
    hashKey([opts.model, opts.reportType, `${partIndex}/${partCount}`, built.system, built.user].join("\u0001"));

  const buildFor = (chunk: TranscriptChunk, partIndex: number, partCount: number) =>
    partCount === 1
      ? buildReportMessages({
          reportType: opts.reportType,
          transcriptBlock: chunk.text,
          caseInfo: opts.caseInfo,
          customInstructions: opts.customInstructions,
          ...speakerContext,
        })
      : buildChunkMessages({
          reportType: opts.reportType,
          transcriptBlock: chunk.text,
          caseInfo: opts.caseInfo,
          customInstructions: opts.customInstructions,
          partIndex,
          partCount,
          rangeLabel: chunk.rangeLabel,
          ...speakerContext,
        });

  const runPiece = async (chunk: TranscriptChunk, partIndex: number, partCount: number, depth: number, callScale: number): Promise<PieceResult> => {
    throwIfAborted(opts.signal);
    if (chunk.estimatedTokens > pieceLimitTokens && depth < 5) {
      const halves = splitChunkInHalf(chunk);
      if (halves) {
        const items: MergeItem[] = [];
        for (const half of halves) items.push(...(await runPiece(half, partIndex, Math.max(2, partCount), depth + 1, callScale)).items);
        return { items, whole: false };
      }
    }
    const built = buildFor(chunk, partIndex, partCount);
    const key = keyFor(built, partIndex, partCount);
    const cached = store?.get(key);
    if (cached && cached.length > 0) {
      resumedParts += 1;
      if (cached.some((item) => item.truncated)) truncated = true;
      return { items: cached, whole: partCount === 1 && cached.length === 1 };
    }
    try {
      const done = await completePart(opts.chat, opts.model, built, {
        kind: partCount === 1 ? "single" : "chunk",
        inputTokens: chunk.estimatedTokens,
        scale: callScale,
      });
      model = done.model || model;
      requestId = done.requestId || requestId;
      if (done.truncated) truncated = true;
      const items: MergeItem[] = [{ rangeLabel: chunk.rangeLabel, text: stripTruncationNote(done.text), truncated: done.truncated }];
      store?.set(key, items);
      savedParts += 1;
      opts.onPartialSaved?.(savedParts, chunks.length);
      return { items, whole: partCount === 1 };
    } catch (error) {
      if (!isSizeError(error)) throw error;
      const halves = depth < 5 ? splitChunkInHalf(chunk) : null;
      if (halves) {
        sizeSplits += 1;
        pieceLimitTokens = Math.min(pieceLimitTokens, Math.max(500, Math.floor(chunk.estimatedTokens / 2)));
        opts.onProgress?.("The service said that piece was too large. Splitting it in half and trying again...", savedParts, chunks.length + 1);
        const items: MergeItem[] = [];
        for (const half of halves) items.push(...(await runPiece(half, partIndex, Math.max(2, partCount), depth + 1, Math.max(0.25, callScale * 0.5))).items);
        store?.set(key, items);
        return { items, whole: false };
      }
      if (callScale > 0.3) {
        opts.onProgress?.("The service said the reply size was too large. Asking for a shorter reply and trying again...", savedParts, chunks.length + 1);
        sizeSplits += 1;
        return runPiece(chunk, partIndex, partCount, depth + 1, callScale * 0.5);
      }
      throw error;
    }
  };

  const segments = segmentUtterances(opts.transcript.utterances);
  const checkTimes = (raw: string): { text: string; timestampCheck?: TimestampCheck; pronounCheck?: PronounCheck } => {
    const text = sortUnclearAudio(raw);
    const found = findGenderedPronouns(text);
    const pronounCheck = found.count ? found : undefined;
    if (!segments.length) return { text, pronounCheck };
    const r = verifyTimestamps(text, segments);
    const { text: fixed, ...counts } = r;
    return { text: sortUnclearAudio(fixed), timestampCheck: counts, pronounCheck };
  };

  const partials: MergeItem[] = [];
  let only: PieceResult | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    opts.onProgress?.(
      chunks.length === 1 ? "Writing the report..." : `Summarizing part ${i + 1} of ${chunks.length} (${chunk.rangeLabel})...`,
      i,
      chunks.length + 1
    );
    const piece = await runPiece(chunk, i + 1, chunks.length, 0, 1);
    if (chunks.length === 1) only = piece;
    partials.push(...piece.items);
  }

  if (chunks.length === 1 && only && only.whole && only.items.length === 1) {
    opts.onProgress?.("Report ready", 1, 1);
    const checkedOnly = checkTimes(only.items[0].text);
    return {
      text: withTruncationWarning(checkedOnly.text, truncated),
      timestampCheck: checkedOnly.timestampCheck,
    pronounCheck: checkedOnly.pronounCheck,
      model,
      requestId,
      transcriptId,
      truncated,
      engine,
      partCount: 1,
      resumedParts,
      sizeSplits,
    };
  }

  const totalSteps = chunks.length + 1;
  const budget = opts.outputBudgetTokens ?? visibleOutputBudget(opts.model);
  const merged = await mergeReportLevels(partials, budget, 0);
  if (merged.truncated) truncated = true;
  model = merged.model || model;
  requestId = merged.requestId || requestId;
  opts.onProgress?.("Report ready", totalSteps, totalSteps);

  const checkedMerged = checkTimes(merged.text);
  return {
    text: withTruncationWarning(checkedMerged.text, truncated),
    timestampCheck: checkedMerged.timestampCheck,
    pronounCheck: checkedMerged.pronounCheck,
    model,
    requestId,
    transcriptId,
    truncated,
    engine,
    partCount: chunks.length,
    resumedParts,
    sizeSplits,
  };

  async function mergeReportLevels(items: MergeItem[], tokenBudget: number, depth: number): Promise<{
    text: string;
    model: string;
    requestId: string | null;
    truncated: boolean;
  }> {
    throwIfAborted(opts.signal);
    if (items.length === 1) {
      return { text: items[0].text, model: opts.model, requestId: null, truncated: false };
    }
    const groups = groupMergeItems(items, tokenBudget);
    const batches = groups.length === items.length && items.length > 2
      ? pairItems(items)
      : groups;
    if (batches.length > 1 && batches.length < items.length && depth < 12) {
      opts.onProgress?.(`Merging ${items.length} parts (${batches.length} groups)...`, chunks.length, totalSteps);
      const next: MergeItem[] = [];
      let childTruncated = false;
      for (let i = 0; i < batches.length; i++) {
        const piece = await mergeReportLevels(batches[i], tokenBudget, depth + 1);
        if (piece.truncated) childTruncated = true;
        model = piece.model || model;
        next.push({ rangeLabel: `group ${i + 1}`, text: stripTruncationNote(piece.text) });
      }
      const top = await mergeReportLevels(next, tokenBudget, depth + 1);
      return { ...top, truncated: top.truncated || childTruncated };
    }

    opts.onProgress?.(`Merging ${items.length} parts into the final report...`, chunks.length, totalSteps);
    const built = buildMergeMessages({
      reportType: opts.reportType,
      partials: items,
      caseInfo: opts.caseInfo,
      customInstructions: opts.customInstructions,
      ...speakerContext,
    });
    const splitAndMerge = async (): Promise<{ text: string; model: string; requestId: string | null; truncated: boolean }> => {
      const mid = Math.ceil(items.length / 2);
      const left = await mergeReportLevels(items.slice(0, mid), tokenBudget, depth + 1);
      const right = await mergeReportLevels(items.slice(mid), tokenBudget, depth + 1);
      const top = await mergeReportLevels(
        [
          { rangeLabel: "earlier", text: stripTruncationNote(left.text) },
          { rangeLabel: "later", text: stripTruncationNote(right.text) },
        ],
        tokenBudget,
        depth + 1
      );
      return { ...top, truncated: top.truncated || left.truncated || right.truncated };
    };
    const inputTokens = items.reduce((sum, item) => sum + estimateTokens(item.text), 0);
    let once;
    try {
      once = await completePart(opts.chat, opts.model, built, { kind: "merge", inputTokens, scale: mergeScale });
    } catch (error) {
      if (!isSizeError(error)) throw error;
      sizeSplits += 1;
      if (items.length > 2 && depth < 12) return splitAndMerge();
      if (mergeScale > 0.3 && depth < 12) {
        mergeScale *= 0.5;
        return mergeReportLevels(items, tokenBudget, depth + 1);
      }
      throw error;
    }
    if (once.truncated && items.length > 2 && depth < 12) return splitAndMerge();
    return once;
  }
}

function pairItems(items: MergeItem[]): MergeItem[][] {
  const pairs: MergeItem[][] = [];
  for (let i = 0; i < items.length; i += 2) pairs.push(items.slice(i, i + 2));
  return pairs;
}