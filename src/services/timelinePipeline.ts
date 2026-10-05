import { estimateTokens } from "./transcriptChunks";
import {
  buildTimelineMergeMessages,
  buildTimelinePartMessages,
  hhmmss,
} from "./reportPrompts";
import {
  completeWithContinuation,
  completionMaxTokens,
  groupMergeItems,
  type MergeItem,
} from "./reportCompletion";
import { withTruncationWarning, type ChatFn } from "./reportPipeline";

export interface TimelineSource {
  name: string;
  interviewType?: string | null;
  summary?: string | null;
  preview?: string | null;
  transcriptId?: string | null;
}

export interface TimelineResult {
  text: string;
  model: string;
  requestId: string | null;
  transcriptIds: string[];
  truncated: boolean;
  partCount: number;
}

/** First lines of a transcript, capped, without walking the word arrays of the whole file. */
export function transcriptPreview(transcript: any, speakerLabels?: Record<string, string> | null, maxChars = 4000): string {
  const utterances = transcript?.utterances;
  if (!Array.isArray(utterances) || utterances.length === 0) {
    return String(transcript?.text || "").slice(0, maxChars);
  }
  let out = "";
  for (const utterance of utterances) {
    if (out.length >= maxChars) break;
    const speaker = utterance?.speaker ?? "?";
    const name = speakerLabels?.[speaker];
    const label = name ? `${name} (Speaker ${speaker})` : `Speaker ${speaker}`;
    const line = `[${hhmmss(utterance?.start)}] ${label}: ${String(utterance?.text || "")}`;
    out += (out ? "\n" : "") + line.slice(0, maxChars);
  }
  return out.slice(0, maxChars);
}

export function sourceBlock(source: TimelineSource): string {
  const preview = (source.preview || "").slice(0, 4000);
  const summary = source.summary || "No summary generated.";
  return `### Recording: ${source.name} (${source.interviewType || "Interview"})\nSummary: ${summary}\nTranscript preview: ${preview}\n`;
}

/** Group recording blocks so each part stays under tokenLimit. One recording is never split across a call. */
export function groupTimelineBlocks(blocks: string[], tokenLimit: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  const limit = Math.max(1, tokenLimit);
  for (const block of blocks) {
    const cost = estimateTokens(block) + 1;
    if (current.length > 0 && tokens + cost > limit) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(block);
    tokens += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

async function complete(chat: ChatFn, model: string, built: { system: string; user: string; firstHeading: string; instructionText: string }) {
  return completeWithContinuation({
    chat,
    model,
    messages: built,
    maxTokens: completionMaxTokens(model),
  });
}

export async function generateCaseTimeline(opts: {
  sources: TimelineSource[];
  model: string;
  tokenLimit?: number;
  chat: ChatFn;
  engineNote?: string;
  onProgress?: (message: string, completed: number, total: number) => void;
}): Promise<TimelineResult> {
  if (opts.sources.length === 0) throw new Error("No recordings found in this case.");
  const blocks = opts.sources.map(sourceBlock);
  const tokenLimit = opts.tokenLimit ?? 100000;
  const groups = estimateTokens(blocks.join("\n")) <= tokenLimit ? [blocks] : groupTimelineBlocks(blocks, Math.min(tokenLimit, 80000));
  const transcriptIds = opts.sources.map((s) => s.transcriptId).filter((id): id is string => Boolean(id));
  let truncated = false;
  let model = opts.model;
  let requestId: string | null = null;

  if (groups.length === 1) {
    opts.onProgress?.("Writing the case timeline…", 0, 1);
    const only = await complete(opts.chat, opts.model, buildTimelinePartMessages({
      partIndex: 1,
      partCount: 1,
      block: groups[0].join("\n"),
      sole: true,
    }));
    truncated = only.truncated;
    model = only.model;
    requestId = only.requestId;
    return {
      text: withTruncationWarning(only.text, truncated),
      model,
      requestId,
      transcriptIds,
      truncated,
      partCount: 1,
    };
  }

  const partials: { rangeLabel: string; text: string }[] = [];
  const steps = groups.length + 1;
  for (let i = 0; i < groups.length; i++) {
    opts.onProgress?.(`Summarizing timeline part ${i + 1} of ${groups.length}…`, i, steps);
    const part = await complete(opts.chat, opts.model, buildTimelinePartMessages({
      partIndex: i + 1,
      partCount: groups.length,
      block: groups[i].join("\n"),
    }));
    if (part.truncated) truncated = true;
    model = part.model;
    partials.push({ rangeLabel: `recordings ${i + 1}`, text: part.text });
  }

  const merged = await mergeTimelineLevels(partials, 0);
  if (merged.truncated) truncated = true;
  return {
    text: withTruncationWarning(merged.text, truncated),
    model: merged.model,
    requestId: merged.requestId,
    transcriptIds,
    truncated,
    partCount: groups.length,
  };

  async function mergeTimelineLevels(items: MergeItem[], depth: number): Promise<{ text: string; model: string; requestId: string | null; truncated: boolean }> {
    if (items.length === 1) return { text: items[0].text, model: opts.model, requestId: null, truncated: false };
    const batches = groupMergeItems(items, 8000);
    if (batches.length > 1 && batches.length < items.length && depth < 12) {
      const next: MergeItem[] = [];
      let childTruncated = false;
      for (let i = 0; i < batches.length; i++) {
        opts.onProgress?.(`Merging timeline group ${i + 1} of ${batches.length}…`, groups.length, steps);
        const piece = await mergeTimelineLevels(batches[i], depth + 1);
        if (piece.truncated) childTruncated = true;
        next.push({ rangeLabel: `group ${i + 1}`, text: piece.text });
      }
      const top = await mergeTimelineLevels(next, depth + 1);
      return { ...top, truncated: top.truncated || childTruncated };
    }
    opts.onProgress?.(`Merging ${items.length} timeline parts…`, groups.length, steps);
    const once = await complete(opts.chat, opts.model, buildTimelineMergeMessages({ partials: items }));
    if (once.truncated && items.length > 2 && depth < 12) {
      const mid = Math.ceil(items.length / 2);
      const left = await mergeTimelineLevels(items.slice(0, mid), depth + 1);
      const right = await mergeTimelineLevels(items.slice(mid), depth + 1);
      const top = await mergeTimelineLevels(
        [
          { rangeLabel: "earlier", text: left.text },
          { rangeLabel: "later", text: right.text },
        ],
        depth + 1
      );
      return { ...top, truncated: top.truncated || left.truncated || right.truncated };
    }
    return once;
  }
}
