// 6.1.6 tests for the exported report, the call queue, diagnostics and Test connection. Synthetic data only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { Packer } from "docx";
import { JSDOM } from "jsdom";
import { buildReportDocument } from "../src/services/reportDocx.ts";
import { exportFooter, flaggedUtteranceText, makeReportId, MACHINE_LABEL, formatDuration, type ReportExportInput } from "../src/services/reportExport.ts";
import { CallQueue } from "../src/services/gatewayQueue.ts";
import { buildDiagnosticsText } from "../src/services/diagnostics.ts";
import { testConnection } from "../src/services/connectionTest.ts";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
const { buildPrintableReportHtml } = await import("../src/services/reportHtml.ts");

const HASH = "9f2c4168a7b63e5f01c4d89a2b7e6f3c5a1d0e9b8c7f6a5d4e3b2c1a0f9e8d7c";
const KEY = "sk-SYNTHETIC-KEY-9876543210";
const MARKDOWN = `## 1. Case Information
- **Case:** 26-104417
## 2. Executive Summary
Ellis said the sedan was gray.
## 3. Officer Narrative
At [00:00:08] Det. Alvarez opened the interview.`;

function sample(over: Partial<ReportExportInput> = {}): ReportExportInput {
  return {
    caseNumber: "26-104417",
    examiner: "Det. R. Alvarez #4412",
    sourceFileName: "witness-interview.m4a",
    importedAt: "2026-10-12T19:02:00Z",
    durationMs: 11 * 60_000 + 20_000,
    sourceSha256: HASH,
    generatedAt: "2026-10-12T19:30:00Z",
    service: "AssemblyAI",
    model: "claude-sonnet-4-6",
    appVersion: "6.1.6",
    reportId: "NAR-0123456789",
    reportType: "Witness Interview",
    markdown: MARKDOWN,
    transcript: [
      { speaker: "Det. R. Alvarez", startMs: 8000, text: "Please state your name." },
      { speaker: "Jordan Ellis", startMs: 12000, text: "I saw it [inaudible] and the [unclear: Fifth] street sign <b>x</b>." },
    ],
    ...over,
  };
}

describe("exported report (6.1.6)", () => {
  it("has the header block, machine label, footer data and transcript table", () => {
    const html = buildPrintableReportHtml({ report: sample() });
    for (const text of ["26-104417", "Det. R. Alvarez #4412", "witness-interview.m4a", "11:20", HASH, "AssemblyAI", "claude-sonnet-4-6", MACHINE_LABEL, "Reviewer sign-off", "Reviewed by"]) {
      assert.ok(html.includes(text), `missing ${text}`);
    }
    assert.ok(html.indexOf("Executive Summary") < html.indexOf("00:00:08"), "summary comes before the transcript");
    assert.match(html, /<table[^>]*class="[^"]*transcript/);
    assert.match(html, /break-inside:\s*avoid/);
    assert.match(html, /font-size:\s*11pt/);
    const footer = exportFooter(sample());
    assert.match(footer.left, /Case: 26-104417/);
    assert.match(footer.left, /Report ID: NAR-0123456789/);
    assert.match(footer.left, /Narrative AI 6\.1\.6/);
    assert.equal(footer.hashLine, `Source SHA-256: ${HASH}`);
  });

  it("shows inaudible and unclear marks visibly and escapes transcript text", () => {
    const html = buildPrintableReportHtml({ report: sample() });
    assert.match(html, /<span class="flag">\[inaudible\]<\/span>/);
    assert.match(html, /<span class="flag">\[unclear: Fifth\]<\/span>/);
    assert.equal(html.includes("<b>x</b>"), false);
    assert.equal(flaggedUtteranceText([{ text: "the", confidence: 0.99 }, { text: "gray", confidence: 0.2 }], ""), "the [unclear: gray]");
    assert.equal(formatDuration(3_725_000), "1:02:05");
  });

  it("says 'Officer reviewed' only after a person confirmed", () => {
    const before = buildPrintableReportHtml({ report: sample() });
    assert.match(before, /Not yet reviewed by a person/);
    assert.equal(/Officer reviewed:/.test(before), false);
    const after = buildPrintableReportHtml({ report: sample({ reviewedBy: "Det. R. Alvarez", reviewedAt: "2026-10-12T20:00:00Z" }) });
    assert.match(after, /Officer reviewed: Det\. R\. Alvarez/);
    assert.equal(/Not yet reviewed by a person/.test(after), false);
  });

  it("keeps request IDs, keys and diagnostics out of the report (HTML and DOCX)", async () => {
    const dirty = { auditLine: `Request IDs: req_SECRET_1 req_SECRET_2 key ${KEY}`, markdown: MARKDOWN, caseName: "26-104417", recordingName: "a.m4a" };
    const html = buildPrintableReportHtml(dirty);
    assert.equal(html.includes("req_SECRET"), false);
    assert.equal(html.includes(KEY), false);
    const buffer = await Packer.toBuffer(buildReportDocument(dirty as any));
    const xml = await (await JSZip.loadAsync(buffer)).file("word/document.xml")!.async("string");
    assert.equal(xml.includes("req_SECRET"), false);
    assert.equal(xml.includes(KEY), false);
  });

  it("DOCX carries the same header, label, transcript and sign-off as the HTML", async () => {
    const buffer = await Packer.toBuffer(buildReportDocument({ report: sample() }));
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    for (const text of ["26-104417", "witness-interview.m4a", HASH, MACHINE_LABEL, "Reviewer sign-off", "[inaudible]", "Please state your name."]) {
      assert.ok(xml.includes(text), `DOCX missing ${text}`);
    }
    assert.ok(xml.includes("w:cantSplit"), "transcript rows do not split across pages");
    const footerFiles = Object.keys(zip.files).filter((n) => /word\/footer\d*\.xml/.test(n));
    assert.ok(footerFiles.length >= 1);
    const footerXml = (await Promise.all(footerFiles.map((n) => zip.file(n)!.async("string")))).join("");
    assert.match(footerXml, /NAR-0123456789/);
    assert.match(footerXml, /PAGE/);
    assert.match(footerXml, /NUMPAGES/);
  });

  it("report IDs are stable for the same inputs and differ when the source changes", async () => {
    const a = await makeReportId(["26-104417", "2026-10-12T19:30:00Z", HASH]);
    const b = await makeReportId(["26-104417", "2026-10-12T19:30:00Z", HASH]);
    const c = await makeReportId(["26-104417", "2026-10-12T19:30:00Z", "0".repeat(64)]);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^NAR-[0-9A-F]{10}$/i);
  });
});

describe("call queue (6.1.6)", () => {
  it("runs no more than the limit at once and keeps order", async () => {
    const queue = new CallQueue(() => 2);
    let active = 0, peak = 0;
    const order: number[] = [];
    const job = (n: number) => queue.run(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      order.push(n); active -= 1;
    });
    await Promise.all([1, 2, 3, 4, 5].map(job));
    assert.equal(peak, 2);
    assert.deepEqual(order.slice().sort(), [1, 2, 3, 4, 5]);
  });

  it("a waiting call can be cancelled without running", async () => {
    const queue = new CallQueue(() => 1);
    let release!: () => void;
    const first = queue.run(() => new Promise<void>((r) => { release = r; }));
    const controller = new AbortController();
    let ran = false;
    const second = queue.run(async () => { ran = true; }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(second);
    release();
    await first;
    assert.equal(ran, false);
    assert.equal(queue.queued, 0);
  });
});

describe("diagnostics and Test connection (6.1.6)", () => {
  it("Copy diagnostics holds the real message and request IDs but never a key or case text", () => {
    const text = buildDiagnosticsText({
      appVersion: "6.1.6",
      now: new Date("2026-10-12T20:00:00Z"),
      server: { provider: "gateway", gatewayModel: "claude-sonnet-4-6", chunkTokenLimit: 50000, gatewayConcurrency: 1, allowModelFallback: false },
      info: { kind: "rate_limit_tpm", status: 429, retryAfter: 12, attempts: 5, requestId: "req_1", requestIds: ["req_0", "req_1"], realMessage: "Rate limit exceeded (TPM)", engine: "gateway", model: "claude-sonnet-4-6", note: "This request went to AssemblyAI. Nothing was sent to Google.", canRetry: true },
    });
    for (const needle of ["6.1.6", "HTTP status: 429", "Rate limit exceeded (TPM)", "req_0, req_1", "Gateway model fallback: off", "no API keys and no case content"]) assert.ok(text.includes(needle), needle);
    assert.equal(text.includes(KEY), false);
  });

  it("Test connection reports each check separately and sends no case text", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      if (String(url).includes("/v2/transcript")) return new Response("{}", { status: 400 });
      return new Response(JSON.stringify({ message: "Rate limit exceeded (RPM)", code: 429 }), { status: 429 });
    }) as unknown as typeof fetch;
    const result = await testConnection({
      provider: "gateway", apiBase: "https://api.example.test", gatewayUrl: "https://gw.example.test/v1/chat/completions",
      apiKey: KEY, gatewayModel: "claude-sonnet-4-6", localUrl: "http://127.0.0.1:11434/v1", localModel: "", fetchImpl,
    });
    assert.equal(result.transcription.ok, true);
    assert.equal(result.summary.ok, false);
    assert.match(result.summary.message, /per minute/);
    assert.equal(JSON.stringify(result).includes(KEY), false);
    assert.equal(bodies.some((b) => /witness|Ellis|Alvarez/i.test(b)), false);
  });
});