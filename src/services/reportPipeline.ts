import { buildChunkMessages, buildMergeMessages, buildReportMessages } from "./reportPrompts";
import {
  completeWithContinuation,
  completionMaxTokens,
  groupMergeItems,
  isTruncatedFinish,
  visibleOutputBudget,
  type ChatFn,
  type ChatMessage,
  type ChatResult,
  type MergeItem,
} from "./reportCompletion";
import { chunkTranscript, type TranscriptChunk } from "./transcriptChunks";
import type { CaseInfo } from "./reportPrompts";
import { listSpeakers, suggestSpeakerNames, type SpeakerSuggestion } from "./speakerNames";

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
}

export interface GeneratedReport {
  text: string;
  model: string;
  requestId: string | null;
  transcriptId: string | null;
  truncated: boolean;
  engine: "assemblyai-gateway" | "gemini";
  partCount: number;
}

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

async function completePart(chat: ChatFn, model: string, messages: Parameters<typeof completeWithContinuation>[0]["messages"]) {
  return completeWithContinuation({
    chat,
    model,
    messages,
    maxTokens: completionMaxTokens(model),
  });
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
  let truncated = false;
  let model = opts.model;
  let requestId: string | null = null;

  const runChunk = async (chunk: TranscriptChunk, partIndex: number, partCount: number) => {
    const built = partCount === 1
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
    return completePart(opts.chat, opts.model, built);
  };

  if (chunks.length === 1) {
    opts.onProgress?.("Writing the report…", 0, 1);
    const only = await runChunk(chunks[0], 1, 1);
    truncated = only.truncated;
    model = only.model;
    requestId = only.requestId;
    opts.onProgress?.("Report ready", 1, 1);
    return {
      text: withTruncationWarning(only.text, truncated),
      model,
      requestId,
      transcriptId,
      truncated,
      engine,
      partCount: 1,
    };
  }

  const partials: MergeItem[] = [];
  const totalSteps = chunks.length + 1;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    opts.onProgress?.(
      `Summarizing part ${i + 1} of ${chunks.length} (${chunk.rangeLabel})…`,
      i,
      totalSteps
    );
    const part = await runChunk(chunk, i + 1, chunks.length);
    if (part.truncated) truncated = true;
    model = part.model;
    partials.push({ rangeLabel: chunk.rangeLabel, text: stripTruncationNote(part.text) });
  }

  const budget = opts.outputBudgetTokens ?? visibleOutputBudget(opts.model);
  const merged = await mergeReportLevels(partials, budget, 0);
  if (merged.truncated) truncated = true;
  model = merged.model || model;
  requestId = merged.requestId;
  opts.onProgress?.("Report ready", totalSteps, totalSteps);

  return {
    text: withTruncationWarning(merged.text, truncated),
    model,
    requestId,
    transcriptId,
    truncated,
    engine,
    partCount: chunks.length,
  };

  async function mergeReportLevels(items: MergeItem[], tokenBudget: number, depth: number): Promise<{
    text: string;
    model: string;
    requestId: string | null;
    truncated: boolean;
  }> {
    if (items.length === 1) {
      return { text: items[0].text, model: opts.model, requestId: null, truncated: false };
    }
    const groups = groupMergeItems(items, tokenBudget);
    const batches = groups.length === items.length && items.length > 2
      ? pairItems(items)
      : groups;
    if (batches.length > 1 && batches.length < items.length && depth < 12) {
      opts.onProgress?.(`Merging ${items.length} parts (${batches.length} groups)…`, chunks.length, totalSteps);
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

    opts.onProgress?.(`Merging ${items.length} parts into the final report…`, chunks.length, totalSteps);
    const built = buildMergeMessages({
      reportType: opts.reportType,
      partials: items,
      caseInfo: opts.caseInfo,
      customInstructions: opts.customInstructions,
      ...speakerContext,
    });
    const once = await completePart(opts.chat, opts.model, built);
    if (once.truncated && items.length > 2 && depth < 12) {
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
    }
    return once;
  }
}

function pairItems(items: MergeItem[]): MergeItem[][] {
  const pairs: MergeItem[][] = [];
  for (let i = 0; i < items.length; i += 2) pairs.push(items.slice(i, i + 2));
  return pairs;
}
