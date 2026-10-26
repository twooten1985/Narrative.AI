// The case report that leaves the app: one layout for PDF, print and DOCX.
// It never carries API keys, gateway request IDs or diagnostics. Those live only in "Copy diagnostics".

import { AI_DISCLAIMER } from "./audit";
import { speakerDisplayName } from "./speakerNames";
import { pronounWarningLine, timestampSummaryLine } from "./timestamps";

export const MACHINE_LABEL = "Machine-generated, requires officer review.";
const LOW_CONFIDENCE = 0.4;

export interface ExportTranscriptRow {
  speaker: string;
  startMs: number;
  /** "gap" rows say that no speech was transcribed. The text is the whole sentence. */
  kind?: "gap";
  endMs?: number;
  /** May hold [inaudible] and [unclear: word] marks. They are drawn visibly. */
  text: string;
}

export interface ReportExportInput {
  caseNumber: string;
  examiner?: string | null;
  sourceFileName: string;
  /** ISO time the recording was added to the app. */
  importedAt?: string | null;
  durationMs?: number | null;
  sourceSha256?: string | null;
  generatedAt?: string | null;
  /** "AssemblyAI", "Local Ollama on this PC" or "Google Gemini". */
  service?: string | null;
  model?: string | null;
  appVersion: string;
  reportId: string;
  reportType?: string | null;
  markdown: string;
  transcript?: ExportTranscriptRow[];
  speakerLabels?: Record<string, string>;
  /** Set only when a person confirmed the review in the app. */
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  acknowledgement?: string | null;
  /** "AssemblyAI" or "Local Whisper on this PC". Defaults to AssemblyAI. */
  transcriptionService?: string | null;
  /** Result of checking the summary's timestamps against the transcript. */
  timestampCheck?: { cited: number; verified: number; corrected: number; unverified: number } | null;
  /** Gendered pronouns found outside quotes in the summary; shown as a header row when above zero. */
  pronounCheck?: { count: number; words: string[] } | null;
}

export interface ExportFooter {
  left: string;
  hashLine: string;
}

export function escapeText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Date and time with the time zone name, in the viewer's zone: "2026-10-25 14:03 CDT". */
export function formatWithZone(value?: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`.trim();
}

export function formatDuration(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "Not recorded";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Text of one utterance with low-confidence words shown as [unclear: word]. */
export function flaggedUtteranceText(
  words: { text: string; confidence?: number }[] | undefined,
  fallbackText: string,
  threshold = LOW_CONFIDENCE,
): string {
  if (!words || !words.length) return fallbackText || "";
  return words
    .map((word) => (typeof word.confidence === "number" && word.confidence < threshold ? `[unclear: ${word.text}]` : word.text))
    .join(" ");
}

/** A short ID that is the same every time the same report is exported. */
export async function makeReportId(parts: (string | number | null | undefined)[]): Promise<string> {
  const data = new TextEncoder().encode(parts.map((part) => String(part ?? "")).join("|"));
  const subtle = (globalThis as any).crypto?.subtle;
  if (!subtle) return "NAR-UNKNOWN";
  const digest = new Uint8Array(await subtle.digest("SHA-256", data));
  const hex = Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `NAR-${hex.slice(0, 10).toUpperCase()}`;
}

export function exportFooter(input: ReportExportInput): ExportFooter {
  return {
    left: `Case: ${input.caseNumber || "Not provided"}  |  Report ID: ${input.reportId}  |  Narrative AI ${input.appVersion}`,
    hashLine: `Source SHA-256: ${input.sourceSha256 || "not recorded"}`,
  };
}

/** "AssemblyAI LLM Gateway, model X", "Local Ollama, model X" or "Google Gemini, model X". */
export function summaryServiceLine(input: Pick<ReportExportInput, "service" | "model">): string {
  const raw = String(input.service || "").trim();
  let name = raw;
  if (/local|ollama/i.test(raw)) name = "Local Ollama";
  else if (/gemini|google/i.test(raw)) name = "Google Gemini";
  else if (/assembly/i.test(raw)) name = "AssemblyAI LLM Gateway";
  if (!name) name = "Not recorded";
  return [name, input.model || ""].filter(Boolean).join(", model ");
}

/** Draws [hh:mm:ss UNVERIFIED] markers in finished summary HTML so they stand out in colour and in black and white. */
export function markUnverifiedHtml(html: string): string {
  return String(html ?? "").replace(/\[(\d{1,2}:\d{2}:\d{2}) UNVERIFIED\]/g, (_m, t) => `<span class="flag unverified">[${t} UNVERIFIED]</span>`);
}

/** Marks short paragraphs so a page break never splits them (long ones may still break, but with 3 lines on each side). */
export function markShortParagraphs(html: string, maxChars = 700): string {
  return String(html ?? "").replace(/<p>([\s\S]*?)<\/p>/g, (m, inner: string) => (inner.replace(/<[^>]*>/g, "").length <= maxChars ? `<p class="short">${inner}</p>` : m));
}

export interface HeaderRow { label: string; value: string; mono?: boolean }

export function headerRows(input: ReportExportInput): HeaderRow[] {
  const summaryLine = summaryServiceLine(input);
  const rows: HeaderRow[] = [
    { label: "Case number", value: input.caseNumber || "Not provided" },
    { label: "Examiner", value: input.examiner || "Not provided" },
    { label: "Report type", value: input.reportType || "Not provided" },
    { label: "Source file", value: input.sourceFileName || "Not provided" },
    { label: "Imported", value: formatWithZone(input.importedAt) },
    { label: "Recording length", value: formatDuration(input.durationMs) },
    { label: "Source SHA-256", value: input.sourceSha256 || "Not recorded (imported before hashing)", mono: true },
    { label: "Generated", value: formatWithZone(input.generatedAt) },
    { label: "Transcription", value: input.transcriptionService || "AssemblyAI" },
    { label: "Summary", value: summaryLine },
  ];
  if (input.timestampCheck) rows.push({ label: "Timestamp check", value: timestampSummaryLine(input.timestampCheck) });
  if (input.pronounCheck && input.pronounCheck.count > 0) rows.push({ label: "Wording check", value: pronounWarningLine(input.pronounCheck) });
  return rows;
}

export function reviewStatus(input: ReportExportInput): string {
  return input.reviewedBy && input.reviewedAt
    ? `Officer reviewed: ${input.reviewedBy}, ${formatWithZone(input.reviewedAt)}`
    : "Not yet reviewed by a person.";
}

const FLAG_RX = /(\[inaudible\]|\[unclear:[^\]]*\])/gi;

/** Escapes text and draws [inaudible] and [unclear: word] marks so they stand out, in colour and in black and white. */
export function flagMarksToHtml(text: string): string {
  return String(text ?? "")
    .split(FLAG_RX)
    .map((piece, index) => (index % 2 === 1 ? `<span class="flag">${escapeText(piece)}</span>` : escapeText(piece)))
    .join("");
}

export const REPORT_CSS = `
  @page { size: Letter; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: "Segoe UI", Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1b1b1b; margin: 0; }
  h1, h2, h3, h4 { color: #1f3a5f; line-height: 1.25; }
  .title { font-size: 20pt; font-weight: 700; color: #1f3a5f; margin: 0 0 2pt; letter-spacing: 0.2pt; }
  .subtitle { font-size: 9.5pt; color: #444; margin: 0 0 12pt; letter-spacing: 0.6pt; text-transform: uppercase; }
  .rule { border: 0; border-top: 1px solid #cfcfcf; margin: 14pt 0; }
  table.meta { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 0 0 8pt; }
  table.meta th { width: 27%; text-align: left; font-weight: 600; color: #1f3a5f; padding: 4pt 8pt 4pt 0; border-bottom: 1px solid #e3e3e3; vertical-align: top; white-space: nowrap; }
  table.meta td { padding: 4pt 0; border-bottom: 1px solid #e3e3e3; vertical-align: top; overflow-wrap: anywhere; }
  table.meta td.mono { font-family: Consolas, "Courier New", monospace; font-size: 8.5pt; word-break: break-all; }
  .machine { margin: 10pt 0 0; padding: 7pt 10pt; border: 1px solid #1b1b1b; font-weight: 700; font-size: 10.5pt; }
  .review { margin: 5pt 0 0; font-size: 10pt; color: #333; }
  h2.section { font-size: 13pt; margin: 0 0 8pt; padding-bottom: 3pt; border-bottom: 1px solid #cfcfcf; }
  .content h1 { font-size: 14pt; margin: 14pt 0 6pt; }
  .content h2 { font-size: 12.5pt; margin: 16pt 0 5pt; padding-bottom: 2pt; border-bottom: 1px solid #dedede; break-after: avoid; }
  .content h3 { font-size: 11.5pt; margin: 12pt 0 4pt; break-after: avoid; }
  .content p, .content li { orphans: 3; widows: 3; }
  .content p { margin: 0 0 7pt; }
  .content p.short { break-inside: avoid; page-break-inside: avoid; }
  .content ul, .content ol { margin: 0 0 8pt; padding-left: 1.3em; }
  .content li { margin-bottom: 3pt; break-inside: avoid; }
  .content blockquote { margin: 6pt 0 8pt; padding-left: 10pt; border-left: 2px solid #9a9a9a; color: #333; }
  .note { margin-top: 16pt; font-size: 9.5pt; color: #333; }
  .transcript-page { break-before: page; page-break-before: always; }
  table.transcript { width: 100%; border-collapse: collapse; font-size: 10pt; }
  table.transcript thead { display: table-header-group; }
  table.transcript th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.6pt; color: #1f3a5f; border-bottom: 1.5px solid #1b1b1b; padding: 4pt 6pt; }
  table.transcript tr { break-inside: avoid; page-break-inside: avoid; }
  table.transcript td { vertical-align: top; padding: 5pt 6pt; border-bottom: 1px solid #e6e6e6; }
  table.transcript td.time { width: 62pt; font-family: Consolas, "Courier New", monospace; font-size: 9pt; color: #333; white-space: nowrap; }
  table.transcript tr.alt td { background: #f1f1f1; }
  table.transcript .who { font-weight: 700; }
  .flag { font-weight: 700; background: #e4e4e4; border-bottom: 1px dotted #1b1b1b; padding: 0 1pt; }
  .flag.unverified { font-weight: 800; color: #000; background: #ffe69a; border: 1.5pt solid #000; outline: 0.75pt solid #000; outline-offset: 1pt; padding: 0 4pt; margin: 0 2pt; font-size: 9.5pt; letter-spacing: 0.2pt; white-space: nowrap; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  table.transcript tr.gap td { font-style: italic; font-weight: 600; background: #fff; color: #1b1b1b; border-top: 1px dashed #777; border-bottom: 1px dashed #777; }
  .signoff { margin-top: 26pt; break-inside: avoid; page-break-inside: avoid; }
  .signoff table { width: 100%; border-collapse: collapse; margin-top: 10pt; }
  .signoff td { padding: 16pt 8pt 0 0; font-size: 10pt; vertical-align: bottom; }
  .signoff .line { border-bottom: 1px solid #1b1b1b; height: 20pt; }
  .signoff .typed { font-size: 10pt; padding-bottom: 2pt; }
`;

export function renderSignoffHtml(input: ReportExportInput): string {
  const reviewed = !!(input.reviewedBy && input.reviewedAt);
  return `<div class="signoff">
      <h2 class="section">Reviewer sign-off</h2>
      <p class="review">${escapeText(reviewStatus(input))}</p>
      <table>
        <tr>
          <td style="width:42%"><div class="line typed">${reviewed ? escapeText(input.reviewedBy) : "&nbsp;"}</div>Reviewed by</td>
          <td style="width:22%"><div class="line typed">${reviewed ? escapeText(formatWithZone(input.reviewedAt).slice(0, 10)) : "&nbsp;"}</div>Date</td>
          <td><div class="line">&nbsp;</div>Signature</td>
        </tr>
      </table>
    </div>`;
}

export function renderTranscriptHtml(input: ReportExportInput): string {
  const rows = input.transcript || [];
  if (!rows.length) return "";
  const order = new Map<string, number>();
  const gapCount = rows.filter((row) => row.kind === "gap").length;
  const body = rows.map((row) => {
    if (row.kind !== "gap" && !order.has(row.speaker)) order.set(row.speaker, order.size);
    if (row.kind === "gap") {
      return `<tr class="gap"><td class="time">${formatClock(row.startMs)}</td><td>${escapeText(row.text)}</td></tr>`;
    }
    const alt = (order.get(row.speaker) || 0) % 2 === 1;
    const who = speakerDisplayName(row.speaker, input.speakerLabels);
    return `<tr${alt ? ' class="alt"' : ""}><td class="time">${formatClock(row.startMs)}</td><td><span class="who">${escapeText(who)}:</span> ${flagMarksToHtml(row.text)}</td></tr>`;
  }).join("\n");
  return `<div class="transcript-page">
      <h2 class="section">Transcript</h2>
      <p class="review">Machine-generated transcript. Passages shown as <span class="flag">[inaudible]</span> or <span class="flag">[unclear: word]</span> were not recognized with confidence. Verify against the source recording.${gapCount ? ` ${gapCount} stretch${gapCount === 1 ? "" : "es"} of more than 60 seconds with no transcribed speech ${gapCount === 1 ? "is" : "are"} marked in the table.` : ""}</p>
      <table class="transcript">
        <thead><tr><th>Time</th><th>Speaker and text</th></tr></thead>
        <tbody>
${body}
        </tbody>
      </table>
    </div>`;
}

export function renderHeaderBlockHtml(input: ReportExportInput): string {
  const rows = headerRows(input).map((row) => `<tr><th>${escapeText(row.label)}</th><td${row.mono ? ' class="mono"' : ""}>${escapeText(row.value)}</td></tr>`).join("\n");
  return `<h1 class="title">Investigative Report</h1>
    <p class="subtitle">Confidential &middot; Law enforcement use only</p>
    <table class="meta">
${rows}
    </table>
    <p class="machine">${escapeText(MACHINE_LABEL)}</p>
    <hr class="rule" />`;
}

export function buildNoteHtml(input: ReportExportInput): string {
  return `<div class="note">
      <p><em>${escapeText(AI_DISCLAIMER)}</em></p>
      ${input.acknowledgement?.trim() ? `<p>${escapeText(input.acknowledgement.trim())}</p>` : ""}
    </div>`;
}