import DOMPurify from "dompurify";
import { marked } from "marked";
import { AI_DISCLAIMER } from "./audit";

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

export function buildPrintableReportHtml(opts: {
  caseName?: string | null;
  recordingName?: string | null;
  interviewType?: string | null;
  reportDate: string;
  officerName?: string | null;
  officerBadge?: string | null;
  markdown: string;
  auditLine: string;
}): string {
  const officer = [opts.officerName, opts.officerBadge ? `#${opts.officerBadge}` : ""].filter(Boolean).join(" ");
  const body = renderReportHtml(opts.markdown);
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Investigative Report - ${escapeHtml(opts.caseName || "Case")}</title>
    <style>
      body { font-family: "Segoe UI", Arial, sans-serif; margin: 40px; color: #111; line-height: 1.5; }
      h1 { font-size: 22px; margin: 0 0 8px; }
      h2 { font-size: 16px; margin-top: 22px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
      h3 { font-size: 14px; margin-top: 16px; }
      .banner { display: flex; justify-content: space-between; border-bottom: 3px solid #000; padding-bottom: 10px; margin-bottom: 16px; }
      .banner small { color: #444; }
      .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 8px; padding: 12px 14px; margin-bottom: 18px; font-size: 13px; }
      .content { font-size: 14px; overflow: visible; max-height: none; }
      .content ul, .content ol { padding-left: 1.3rem; }
      .content p, .content li, .content h1, .content h2, .content h3 { overflow: visible; max-height: none; page-break-inside: auto; break-inside: auto; }
      .content h2, .content h3 { break-after: avoid; }
      .disclaimer { margin-top: 28px; border-top: 1px solid #999; padding-top: 8px; font-size: 12px; color: #333; }
      .disclaimer strong { font-style: italic; }
      @media print { body { margin: 12px; } .content, .content p, .content li { overflow: visible; page-break-inside: auto; } }
    </style>
  </head>
  <body>
    <div class="banner">
      <div>
        <h1>OFFICIAL INVESTIGATIVE REPORT</h1>
        <small>Narrative AI</small>
      </div>
      <div><small>CONFIDENTIAL / LAW ENFORCEMENT USE ONLY</small></div>
    </div>
    <div class="meta">
      <div><strong>Case:</strong> ${escapeHtml(opts.caseName || "Not provided")}</div>
      <div><strong>Recording:</strong> ${escapeHtml(opts.recordingName || "Not provided")}</div>
      <div><strong>Report type:</strong> ${escapeHtml(opts.interviewType || "Not provided")}</div>
      <div><strong>Report date:</strong> ${escapeHtml(opts.reportDate)}</div>
      <div><strong>Officer:</strong> ${escapeHtml(officer || "Not provided")}</div>
    </div>
    <div class="content">${body}</div>
    <div class="disclaimer">
      <p><strong>${escapeHtml(AI_DISCLAIMER)}</strong></p>
      <p>${escapeHtml(opts.auditLine)}</p>
    </div>
  </body>
</html>`;
}
