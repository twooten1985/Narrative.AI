import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

const { renderReportHtml, escapeHtml, buildPrintableReportHtml } = await import("../src/services/reportHtml.ts");

describe("report html", () => {
  it("renders markdown and strips script tags", () => {
    const html = renderReportHtml("## 1. Case Information\n\n<script>alert(1)</script>\n\n**Bold** and *italic*");
    assert.match(html, /<h2>/);
    assert.match(html, /<strong>Bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
    assert.equal(html.toLowerCase().includes("<script"), false);
    assert.equal(html.includes("alert(1)"), false);
  });

  it("escapes case and recording names in the printable document", () => {
    const page = buildPrintableReportHtml({
      caseName: `Case <img src=x onerror=alert(1)>`,
      recordingName: `rec "quoted" & file`,
      interviewType: "Jail Phone Calls",
      reportDate: "2026-10-05 01:00:00",
      officerName: "A. Officer",
      officerBadge: "4412",
      markdown: "## 1. Case Information\n\nNothing else.",
      auditLine: "Model: claude-sonnet-4-6 | Request ID: req_1 | Transcript ID: tr_1 | Generated: 2026-10-05 01:00:00",
    });
    assert.equal(page.includes("<img"), false);
    assert.match(page, /Case &lt;img/);
    assert.match(page, /rec &quot;quoted&quot; &amp; file/);
    assert.match(page, /AI-assisted summary/);
    const withAck = buildPrintableReportHtml({
      caseName: "Case",
      recordingName: "room.mp3",
      interviewType: "Suspect Interview",
      reportDate: "2026-10-05",
      markdown: "## Final Summary\nOverview.",
      auditLine: "Model: claude-sonnet-4-6",
      acknowledgement: "AI use acknowledged by user on Oct 5, 2026 7:09 PM CDT.",
    });
    assert.match(withAck, /AI use acknowledged by user on Oct 5, 2026 7:09 PM CDT/);
    assert.match(page, /#4412/);
    assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  });
});
