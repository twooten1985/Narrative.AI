import { DEFAULT_CHUNK_TOKEN_LIMIT, PER_CHUNK_TOKEN_CAP, TARGET_CHUNK_MS } from "./config";
import { hhmmss, transcriptLines, type TranscriptLine } from "./reportPrompts";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface TranscriptChunk {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  utteranceCount: number;
  estimatedTokens: number;
  rangeLabel: string;
}

export interface ChunkOptions {
  /** Split only when the whole transcript is over this many tokens. Default 100_000. */
  tokenLimit?: number;
  /** Target length of each block once splitting starts. Default 25 minutes. */
  targetBlockMs?: number;
  /** Hard cap on a single block so one call stays inside the model context. */
  perChunkTokenCap?: number;
}

function makeChunk(lines: TranscriptLine[], index: number): TranscriptChunk {
  const text = lines.map((l) => l.line).join("\n");
  const startMs = lines[0]?.start ?? 0;
  const endMs = lines[lines.length - 1]?.end ?? startMs;
  return {
    index,
    startMs,
    endMs,
    text,
    utteranceCount: lines.length,
    estimatedTokens: estimateTokens(text),
    rangeLabel: `${hhmmss(startMs)}–${hhmmss(endMs)}`,
  };
}

/**
 * Split a speaker-labelled transcript into roughly 20–30 minute blocks when the
 * recording is longer than that, or when it exceeds tokenLimit. A 6-hour interview
 * is several blocks even if the transcript text itself fits in the model context,
 * because the written report does not fit in one output cap. Utterances are never split.
 */
export function chunkTranscriptLines(lines: TranscriptLine[], opts: ChunkOptions = {}): TranscriptChunk[] {
  if (lines.length === 0) return [];
  const tokenLimit = opts.tokenLimit ?? DEFAULT_CHUNK_TOKEN_LIMIT;
  const targetBlockMs = opts.targetBlockMs ?? TARGET_CHUNK_MS;
  const perChunkTokenCap = opts.perChunkTokenCap ?? Math.min(PER_CHUNK_TOKEN_CAP, tokenLimit);

  const full = lines.map((l) => l.line).join("\n");
  const span = (lines[lines.length - 1]?.end ?? 0) - (lines[0]?.start ?? 0);
  if (estimateTokens(full) <= tokenLimit && span <= targetBlockMs) {
    return [makeChunk(lines, 0)];
  }

  const groups: TranscriptLine[][] = [];
  let current: TranscriptLine[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    groups.push(current);
    current = [];
    currentTokens = 0;
  };

  for (const line of lines) {
    const tokens = estimateTokens(line.line) + 1;
    const startsNewBlock =
      current.length > 0 && line.start - current[0].start >= targetBlockMs;
    const overTokenCap = current.length > 0 && currentTokens + tokens > perChunkTokenCap;
    if (startsNewBlock || overTokenCap) flush();
    current.push(line);
    currentTokens += tokens;
  }
  flush();

  return groups.map((group, index) => makeChunk(group, index));
}

export function chunkTranscript(
  transcript: { text?: string | null; utterances?: any[] | null },
  speakerLabels?: Record<string, string> | null,
  opts: ChunkOptions = {}
): TranscriptChunk[] {
  const lines = transcriptLines(transcript, speakerLabels);
  if (lines.length === 0) {
    const text = transcript?.text || "";
    if (!text) return [];
    return [{
      index: 0,
      startMs: 0,
      endMs: 0,
      text,
      utteranceCount: 0,
      estimatedTokens: estimateTokens(text),
      rangeLabel: "full recording",
    }];
  }
  return chunkTranscriptLines(lines, opts);
}
