import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  REPORT_CSS,
  buildNoteHtml,
  markShortParagraphs,
  markUnverifiedHtml,
  renderHeaderBlockHtml,
  renderSignoffHtml,
  renderTranscriptHtml,
  type ReportExportInput,
} from "./reportExport";
import { sortUnclearAudio } from "./timestamps";

marked.setOptions({ gfm: true, breaks: false });

export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function purifier() {
  const candidate = DOMPurify as unknown as { sanitize?: (html: string, cfg?: object) => string };
  if (typeof candidate.sanitize === "function") return candidate;
  const factory = DOMPurify as unknown as (window: Window) => { sanitize: (html: string, cfg?: object) => string };
  if (typeof window === "undefined") {
    throw new Error("Safe report HTML needs a browser window.");
  }
  return factory(window);
}

/** Markdown to HTML, then DOMPurify. Raw HTML in the model output is stripped. */
export function renderReportHtml(markdown: string | null | undefined): string {
  const raw = marked.parse(markdown || "", { async: false }) as string;
  return purifier().sanitize(raw, {
    USE_PROFILES: { html: true },
  });
}

export interface PrintableReportOptions {
  /** The full case-report description. Preferred. */
  report?: ReportExportInput;
  /** Older fields. Used only when `report` is not given. */
  caseName?: string | null;
  recordingName?: string | null;
  interviewType?: string | null;
  reportDate?: string;
  officerName?: string | null;
  officerBadge?: string | null;
  markdown?: string;
  auditLine?: string;
  acknowledgement?: string | null;
}

/** Builds the export description from the older fields. The audit line (request IDs) is never copied. */
export function reportFromLegacy(opts: PrintableReportOptions): ReportExportInput {
  const officer = [opts.officerName, opts.officerBadge ? `#${opts.officerBadge}` : ""].filter(Boolean).join(" ");
  return {
    caseNumber: opts.caseName || "",
    examiner: officer || null,
    sourceFileName: opts.recordingName || "",
    generatedAt: opts.reportDate || null,
    appVersion: "",
    reportId: "NAR-UNSET",
    reportType: opts.interviewType || null,
    markdown: opts.markdown || "",
    acknowledgement: opts.acknowledgement || null,
  };
}

/**
 * The printable case report: header block and summary on page one, the full transcript on a new page,
 * a reviewer sign-off at the end. Quiet styling that still reads well in black and white.
 * It carries no API keys, request IDs or diagnostics.
 */
export function buildPrintableReportHtml(opts: PrintableReportOptions): string {
  const report = opts.report || reportFromLegacy(opts);
  const body = markShortParagraphs(markUnverifiedHtml(renderReportHtml(sortUnclearAudio(report.markdown))));
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Investigative Report - ${escapeHtml(report.caseNumber || "Case")}</title>
    <style>
${REPORT_CSS}
      .content, .content p, .content li, .content h1, .content h2, .content h3 { overflow: visible; max-height: none; page-break-inside: auto; }
      @media print { .content, .content p, .content li { overflow: visible; page-break-inside: auto; } }
    </style>
  </head>
  <body>
    ${renderHeaderBlockHtml(report)}
    <h2 class="section">Summary</h2>
    <div class="content">${body}</div>
    ${buildNoteHtml(report)}
    ${renderTranscriptHtml(report)}
    ${renderSignoffHtml(report)}
  </body>
</html>`;
}