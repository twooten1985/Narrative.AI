import { WHISPER_OVERLAP_MS, WHISPER_SEGMENT_MS } from "./memoryLimits";

export interface WhisperSegmentPlan {
  index: number;
  startMs: number;
  endMs: number;
  overlapMs: number;
}

export interface WhisperChunk {
  text: string;
  /** Seconds from the start of this segment, not the recording. */
  start: number;
  end: number;
}

export interface WhisperSegmentResult {
  index: number;
  startMs: number;
  overlapMs: number;
  chunks: WhisperChunk[];
}

export interface StitchedWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
  speaker: string;
}

export interface StitchedUtterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  words: StitchedWord[];
}

export interface StitchedTranscript {
  text: string;
  words: StitchedWord[];
  utterances: StitchedUtterance[];
}

/** Split a duration into fixed windows. Later windows repeat overlapMs of the previous one. */
export function planWhisperSegments(
  durationMs: number,
  segmentMs = WHISPER_SEGMENT_MS,
  overlapMs = WHISPER_OVERLAP_MS
): WhisperSegmentPlan[] {
  const duration = Math.max(0, Math.round(durationMs));
  const size = Math.max(1000, Math.round(segmentMs));
  const overlap = Math.max(0, Math.min(Math.round(overlapMs), Math.floor(size / 2)));
  if (duration === 0) return [{ index: 0, startMs: 0, endMs: 0, overlapMs: 0 }];
  if (duration <= size) return [{ index: 0, startMs: 0, endMs: duration, overlapMs: 0 }];

  const plans: WhisperSegmentPlan[] = [];
  let start = 0;
  let index = 0;
  while (start < duration) {
    const end = Math.min(duration, start + size);
    plans.push({ index, startMs: start, endMs: end, overlapMs: index === 0 ? 0 : overlap });
    if (end >= duration) break;
    start = end - overlap;
    index += 1;
    if (index > 100000) break;
  }
  return plans;
}

function wordsForChunk(text: string, absStartMs: number, absEndMs: number): StitchedWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const span = Math.max(1, absEndMs - absStartMs);
  const wordDuration = span / Math.max(1, parts.length);
  const words: StitchedWord[] = [];
  for (let i = 0; i < parts.length; i++) {
    const stripped = parts[i].replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "");
    if (!stripped) continue;
    const wStart = absStartMs + i * wordDuration;
    words.push({
      text: parts[i],
      start: Math.round(wStart),
      end: Math.round(wStart + wordDuration),
      confidence: 0.9,
      speaker: "A",
    });
  }
  return words;
}

/**
 * Put segment chunks on the recording timeline. Chunks that start inside the
 * overlap of a later segment are dropped so the overlap is not transcribed twice.
 */
export function stitchWhisperSegments(segments: WhisperSegmentResult[]): StitchedTranscript {
  const ordered = [...segments].sort((a, b) => a.index - b.index);
  const utterances: StitchedUtterance[] = [];
  const words: StitchedWord[] = [];

  for (const segment of ordered) {
    const skipBeforeSec = segment.overlapMs / 1000;
    for (const chunk of segment.chunks) {
      const text = (chunk.text || "").trim();
      if (!text) continue;
      if (chunk.start < skipBeforeSec - 0.05) continue;
      const absStart = Math.round(segment.startMs + chunk.start * 1000);
      const absEnd = Math.round(segment.startMs + Math.max(chunk.end, chunk.start) * 1000);
      const utteranceWords = wordsForChunk(text, absStart, Math.max(absEnd, absStart + 1));
      words.push(...utteranceWords);
      utterances.push({
        speaker: "A",
        text,
        start: absStart,
        end: Math.max(absEnd, absStart + 1),
        words: utteranceWords,
      });
    }
  }

  return {
    text: utterances.map((u) => u.text).join(" "),
    words,
    utterances,
  };
}

/** Decode PCM s16le WAV samples to float32 in [-1, 1]. Finds the data chunk so extra header chunks are skipped. */
export function wavPcm16ToFloat32(buffer: Buffer): Float32Array {
  let dataStart = 44;
  let dataSize = Math.max(0, buffer.length - dataStart);
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF") {
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString("ascii", offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === "data") {
        dataStart = offset + 8;
        dataSize = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
  }
  const available = Math.max(0, Math.min(dataSize, buffer.length - dataStart));
  const sampleCount = Math.floor(available / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buffer.readInt16LE(dataStart + i * 2) / 32768;
  }
  return samples;
}
