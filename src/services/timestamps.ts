/**
 * Timestamps in a summary must point at the transcript.
 *
 * 1. segmentUtterances: a long utterance is cut into segments of at most 30 seconds, using the word
 *    times, so the model (and the exported transcript) both get a real time for every passage.
 * 2. verifyTimestamps: every [hh:mm:ss] in the written report is checked against those segments.
 *    The time must fall inside the transcript, and a quotation next to it must appear near it.
 *    A wrong time is corrected when the quote is found elsewhere; otherwise it is marked UNVERIFIED.
 * 3. findGaps: stretches with no transcribed speech.
 */
export const MAX_SEGMENT_MS = 30_000;
export const SOFT_SEGMENT_MS = 15_000;
export const GAP_MIN_MS = 60_000;
export const UNVERIFIED_WORD = "UNVERIFIED";

export interface WordLike { text: string; start?: number; end?: number; confidence?: number; speaker?: string }
export interface UtteranceLike { speaker?: string | number; text?: string; start?: number; end?: number; words?: WordLike[] }

export interface TimedSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
  words?: WordLike[];
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function segmentUtterance(u: UtteranceLike): TimedSegment[] {
  const speaker = String(u.speaker ?? "");
  const start = Number(u.start) || 0;
  const end = Number(u.end) || start;
  const words = Array.isArray(u.words) ? u.words.filter((w) => typeof w?.text === "string") : [];
  const whole: TimedSegment = { speaker, startMs: start, endMs: end, text: u.text ?? words.map((w) => w.text).join(" "), words: words.length ? words : undefined };
  if (!words.length || end - start <= MAX_SEGMENT_MS) return [whole];
  const segments: TimedSegment[] = [];
  let current: WordLike[] = [];
  let segStart = Number(words[0].start);
  if (!Number.isFinite(segStart)) return [whole];
  const flush = () => {
    if (!current.length) return;
    const last = current[current.length - 1];
    segments.push({
      speaker,
      startMs: Number(current[0].start) || segStart,
      endMs: Number(last.end) || Number(last.start) || segStart,
      text: current.map((w) => w.text).join(" "),
      words: current,
    });
    current = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const ws = Number(w.start);
    const prev = current[current.length - 1];
    if (current.length && Number.isFinite(ws)) {
      const sinceStart = ws - (Number(current[0].start) || segStart);
      const prevEndsSentence = prev && /[.?!]["')\]]?$/.test(prev.text);
      if (sinceStart >= MAX_SEGMENT_MS || (sinceStart >= SOFT_SEGMENT_MS && prevEndsSentence)) {
        flush();
        segStart = ws;
      }
    }
    current.push(w);
  }
  flush();
  return segments.length ? segments : [whole];
}

export function segmentUtterances(utterances: UtteranceLike[] | null | undefined): TimedSegment[] {
  if (!Array.isArray(utterances)) return [];
  return utterances.flatMap((u) => segmentUtterance(u));
}

export interface TranscriptGap { fromMs: number; toMs: number }

export function findGaps(segments: { startMs: number; endMs: number }[], opts: { minMs?: number; durationMs?: number | null } = {}): TranscriptGap[] {
  const minMs = opts.minMs ?? GAP_MIN_MS;
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const gaps: TranscriptGap[] = [];
  if (!sorted.length) return gaps;
  let reach = 0;
  for (const seg of sorted) {
    if (seg.startMs - reach > minMs) gaps.push({ fromMs: reach, toMs: seg.startMs });
    reach = Math.max(reach, seg.endMs);
  }
  const duration = Number(opts.durationMs) || 0;
  if (duration - reach > minMs) gaps.push({ fromMs: reach, toMs: duration });
  return gaps;
}

export function gapLabel(gap: TranscriptGap): string {
  return `No speech transcribed from ${clock(gap.fromMs)} to ${clock(gap.toMs)}`;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
const CITE_RX = /\[(\d{1,2}):(\d{2}):(\d{2})(?:\s+UNVERIFIED)?\]/g;

export function normalizeForMatch(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\[unclear:\s*([^\]]*)\]/g, "$1")
    .replace(/\[inaudible\]/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Quotations of three or more words, in straight or curly quotes. Parts split by "..." are kept apart. */
export function extractQuotes(text: string): string[] {
  const quotes: string[] = [];
  const rx = /"([^"\n]{8,400})"|\u201c([^\u201d\n]{8,400})\u201d/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    const raw = (m[1] ?? m[2] ?? "").split(/\.{3}|\u2026|\[\.\.\.\]/);
    for (const part of raw) {
      const norm = normalizeForMatch(part);
      if (norm.split(" ").filter(Boolean).length >= 3) quotes.push(norm);
    }
  }
  return quotes;
}

export interface TimestampCheckResult {
  text: string;
  cited: number;
  verified: number;
  corrected: number;
  unverified: number;
  changes: { from: string; to: string; quote: string }[];
  flagged: { at: string; reason: string }[];
}

function segmentHaystack(seg: TimedSegment): string {
  return normalizeForMatch(seg.text);
}

export function verifyTimestamps(markdown: string, segments: TimedSegment[], opts: { nearMs?: number } = {}): TimestampCheckResult {
  // A cited time must land on the line that holds the quote: within a few seconds of that line, not "somewhere close".
  const nearMs = opts.nearMs ?? 4_000;
  const result: TimestampCheckResult = { text: markdown, cited: 0, verified: 0, corrected: 0, unverified: 0, changes: [], flagged: [] };
  if (!markdown || !segments.length) return result;
  const hay = segments.map(segmentHaystack);
  // A quotation may run across the cut between two neighbouring segments.
  const holds = (i: number, quote: string) => hay[i].includes(quote) || (i + 1 < hay.length && !hay[i + 1].includes(quote) && `${hay[i]} ${hay[i + 1]}`.includes(quote));
  const first = Math.min(...segments.map((s) => s.startMs));
  const last = Math.max(...segments.map((s) => s.endMs));

  const cites: { index: number; length: number; ms: number }[] = [];
  CITE_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_RX.exec(markdown))) {
    cites.push({ index: m.index, length: m[0].length, ms: (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 });
  }
  if (!cites.length) return result;

  const lineStart = (pos: number) => markdown.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = (pos: number) => { const i = markdown.indexOf("\n", pos); return i < 0 ? markdown.length : i; };

  const replacements: { index: number; length: number; value: string }[] = [];
  cites.forEach((cite, n) => {
    result.cited += 1;
    const label = clock(cite.ms);
    const prevCite = cites[n - 1];
    const nextCite = cites[n + 1];
    const afterEnd = Math.min(nextCite ? nextCite.index : markdown.length, lineEnd(cite.index + cite.length));
    let after = markdown.slice(cite.index + cite.length, afterEnd);
    // A quotation that sits directly in front of the next time belongs to that time, not to this one.
    if (nextCite && afterEnd === nextCite.index) after = after.replace(/["\u201c][^"\u201c\u201d]*["\u201d][.,;:)\]]?\s*$/, "");
    const beforeStart = Math.max(prevCite ? prevCite.index + prevCite.length : 0, lineStart(cite.index));
    const before = markdown.slice(beforeStart, cite.index);
    // The claim a time belongs to: the text after it, else a quotation just before it.
    let quotes = extractQuotes(after);
    // Only a quotation that the time directly follows ("... dark." [00:01:39]) belongs to it.
    if (!quotes.length && /["\u201d][.,;:)\]]?\s*$/.test(before)) quotes = extractQuotes(before);

    const inTranscript = cite.ms >= first - 1000 && cite.ms <= last + 1500;
    const exists = inTranscript && segments.some((s) => cite.ms >= s.startMs - 1000 && cite.ms <= s.endMs + 1500);
    const nearIdx = (ms: number) => segments.map((s, i) => ({ s, i })).filter(({ s }) => s.endMs >= ms - nearMs && s.startMs <= ms + nearMs).map(({ i }) => i);

    let status: "ok" | "fixed" | "bad" = "ok";
    let fixTo = 0;
    let reason = "";
    if (!exists) {
      status = "bad";
      reason = inTranscript ? "no speech is transcribed at that time" : "that time is outside the transcript";
    }
    if (quotes.length) {
      const quote = quotes.sort((a, b) => b.length - a.length)[0];
      const near = nearIdx(cite.ms).some((i) => holds(i, quote));
      if (near) {
        status = "ok";
      } else {
        let matches: number[] = [];
        hay.forEach((_h, i) => { if (holds(i, quote)) matches.push(i); });
        if (matches.length) {
          matches.sort((a, b) => Math.abs(segments[a].startMs - cite.ms) - Math.abs(segments[b].startMs - cite.ms));
          // A quotation that occurs more than once is only corrected when one occurrence is clearly the closest.
          const unambiguous = matches.length === 1 ||
            Math.abs(segments[matches[0]].startMs - cite.ms) * 2 < Math.abs(segments[matches[1]].startMs - cite.ms);
          if (unambiguous) { status = "fixed"; fixTo = segments[matches[0]].startMs; }
          else { status = "bad"; reason = "the quoted words appear at several other times"; }
        } else {
          status = "bad";
          reason = "the quoted words were not found in the transcript";
        }
      }
    }
    if (status === "ok") {
      result.verified += 1;
      if (/UNVERIFIED/.test(markdown.slice(cite.index, cite.index + cite.length))) {
        replacements.push({ index: cite.index, length: cite.length, value: `[${label}]` });
      }
    } else if (status === "fixed") {
      result.corrected += 1;
      result.verified += 1;
      const to = clock(fixTo);
      result.changes.push({ from: label, to, quote: (quotes[0] || "").slice(0, 60) });
      replacements.push({ index: cite.index, length: cite.length, value: `[${to}]` });
    } else {
      result.unverified += 1;
      result.flagged.push({ at: label, reason });
      replacements.push({ index: cite.index, length: cite.length, value: `[${label} ${UNVERIFIED_WORD}]` });
    }
  });

  let out = "";
  let pos = 0;
  for (const r of replacements.sort((a, b) => a.index - b.index)) {
    out += markdown.slice(pos, r.index) + r.value;
    pos = r.index + r.length;
  }
  out += markdown.slice(pos);
  result.text = out;
  return result;
}

export function timestampSummaryLine(r: { cited: number; verified: number; corrected: number; unverified: number }): string {
  if (!r.cited) return "No timestamps cited in the summary.";
  const parts = [`${r.cited} cited`, `${r.verified} verified against the transcript`];
  if (r.corrected) parts.push(`${r.corrected} corrected`);
  parts.push(r.unverified ? `${r.unverified} marked UNVERIFIED` : "0 unverified");
  return parts.join(", ");
}
// ---------------------------------------------------------------------------
// Unclear Audio list order and gendered-pronoun check (6.1.6 follow-up)
// ---------------------------------------------------------------------------

const UNCLEAR_HEADING_RX = /^#{1,6}\s*(?:\d+[.)]\s*)?Unclear Audio\b/i;
const LIST_ITEM_RX = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** Puts the items of the "Unclear Audio" list in time order (earliest first). Items with no time keep their order at the end. Safe to run twice. */
export function sortUnclearAudio(markdown: string): string {
  if (!markdown) return markdown;
  const lines = markdown.split("\n");
  const h = lines.findIndex((l) => UNCLEAR_HEADING_RX.test(l.trim()));
  if (h < 0) return markdown;
  let end = h + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end]) && (lines[end].trim() === "" || LIST_ITEM_RX.test(lines[end]) || /^\s+\S/.test(lines[end]))) end++;
  const region = lines.slice(h + 1, end);
  let lead = 0;
  while (lead < region.length && region[lead].trim() === "") lead++;
  let tail = region.length;
  while (tail > lead && region[tail - 1].trim() === "") tail--;
  const body = region.slice(lead, tail);
  if (!body.length || !LIST_ITEM_RX.test(body[0])) return markdown;
  const items: string[][] = [];
  for (const line of body) {
    if (LIST_ITEM_RX.test(line) || !items.length) items.push([line]);
    else items[items.length - 1].push(line);
  }
  if (items.length < 2) return markdown;
  const numbered = /^\s*\d/.test(items[0][0]);
  const keyOf = (item: string[]) => {
    CITE_RX.lastIndex = 0;
    const m = CITE_RX.exec(item.join(" "));
    return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : Number.POSITIVE_INFINITY;
  };
  const sorted = items.map((item, i) => ({ item, i, k: keyOf(item) })).sort((a, b) => (a.k === b.k ? a.i - b.i : a.k < b.k ? -1 : 1));
  const out: string[] = [];
  sorted.forEach(({ item }, n) => {
    const copy = item.slice();
    if (numbered) copy[0] = copy[0].replace(/^(\s*)\d+([.)])/, `$1${n + 1}$2`);
    out.push(...copy);
  });
  return [...lines.slice(0, h + 1), ...region.slice(0, lead), ...out, ...region.slice(tail), ...lines.slice(end)].join("\n");
}

export interface PronounCheck { count: number; words: string[] }

/** Looks for he, she, him, her, his, hers (and himself, herself) outside direct quotes. A warning only: "her" can be a correct word in a quote or a name. */
export function findGenderedPronouns(markdown: string): PronounCheck {
  const text = String(markdown || "")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/\u201c[^\u201c\u201d]*\u201d/g, " ")
    .replace(/`[^`]*`/g, " ");
  const found = text.match(/\b(?:he|she|him|her|his|hers|himself|herself)\b/gi) || [];
  return { count: found.length, words: Array.from(new Set(found.map((w) => w.toLowerCase()))).sort() };
}

export function pronounWarningLine(c: PronounCheck): string {
  return `${c.count} gendered pronoun${c.count === 1 ? "" : "s"} outside quotes (${c.words.join(", ")}). Check the wording against the transcript.`;
}
