import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { Packer } from "docx";
import Database from "better-sqlite3";
import { generateInvestigativeReport, type ChatFn } from "../src/services/reportPipeline.ts";
import { buildReportDocument } from "../src/services/reportDocx.ts";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

const { renderReportHtml, buildPrintableReportHtml } = await import("../src/services/reportHtml.ts");

const FINAL = "## 9. Unclear Audio\nFINAL-SECTION-MARKER";

function sixHourTranscript() {
  const utterances = [];
  for (let minute = 0; minute <= 360; minute += 15) {
    const start = minute * 60 * 1000;
    utterances.push({
      speaker: minute % 30 === 0 ? "A" : "B",
      start,
      end: start + 4000,
      text: `At minute ${minute} the speaker described the blue car.`,
    });
  }
  return { id: "tr_six_hours", utterances };
}

describe("six-hour report", () => {
  it("saves, renders, and exports the final section after a length cutoff", async () => {
    const chat: ChatFn = async (args) => {
      const user = args.messages.find((message) => message.role === "user")?.content || "";
      if (user.includes("Continue the report from the cutoff")) {
        return { content: FINAL, model: "claude-sonnet-4-6", requestId: "req_tail", finishReason: "stop" };
      }
      return {
        content: "## 1. Case Information\nThe account stops before the later hours.",
        model: "claude-sonnet-4-6",
        requestId: "req_cut",
        finishReason: "length",
      };
    };

    const result = await generateInvestigativeReport({
      reportType: "Suspect Interview",
      transcript: sixHourTranscript(),
      model: "claude-sonnet-4-6",
      chat,
    });

    assert.ok(result.partCount >= 8, `expected a 6-hour file to be chunked, parts=${result.partCount}`);
    assert.equal(result.truncated, false);
    assert.match(result.text, /## 9\. Unclear Audio/);
    assert.match(result.text, /FINAL-SECTION-MARKER/);

    const db = new Database(":memory:");
    db.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY, summary TEXT, report_meta TEXT)");
    db.prepare("INSERT INTO recordings (id, summary, report_meta) VALUES (?, ?, ?)").run(
      "rec",
      result.text,
      JSON.stringify({ truncated: result.truncated })
    );
    const saved = db.prepare("SELECT summary FROM recordings WHERE id = ?").get("rec") as { summary: string };
    assert.equal(saved.summary, result.text);
    assert.match(saved.summary, /FINAL-SECTION-MARKER/);

    const html = renderReportHtml(saved.summary);
    assert.match(html, /FINAL-SECTION-MARKER/);
    assert.match(html, /<h2[^>]*>9\. Unclear Audio<\/h2>/);

    const printable = buildPrintableReportHtml({
      caseName: "Six hour",
      recordingName: "body-cam.mp4",
      interviewType: "Suspect Interview",
      reportDate: "2026-10-05",
      markdown: saved.summary,
      auditLine: "Model: claude-sonnet-4-6 | Request ID: req_tail | Transcript ID: tr_six_hours | Generated: 2026-10-05",
    });
    assert.match(printable, /FINAL-SECTION-MARKER/);
    assert.equal(printable.includes("overflow: hidden"), false);
    assert.equal(printable.includes("line-clamp"), false);
    const heights: string[] = printable.match(/max-height\s*:\s*[^;]+/g) ?? [];
    assert.ok(heights.length > 0 && heights.every((rule) => rule.includes("none")));
    assert.match(printable, /page-break-inside:\s*auto/);

    const docx = await Packer.toBuffer(buildReportDocument({
      caseName: "Six hour",
      recordingName: "body-cam.mp4",
      reportMarkdown: saved.summary,
      reportDate: "2026-10-05",
      auditLine: "Model: claude-sonnet-4-6",
    }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-docx-"));
    const docxPath = path.join(dir, "report.docx");
    fs.writeFileSync(docxPath, docx);
    const xml = execFileSync("unzip", ["-p", docxPath, "word/document.xml"], { encoding: "utf8" });
    assert.match(xml, /FINAL-SECTION-MARKER/);
    assert.match(xml, /Unclear Audio/);

    const pdf = await printHtmlToPdf(printable);
    assert.ok(pdf.length > 1000);
    const pdfText = extractPdfText(pdf);
    assert.match(pdfText, /FINAL-SECTION-MARKER/);
    assert.match(pdfText, /Unclear Audio/);
  });
});

async function printHtmlToPdf(html: string): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-pdf-"));
  const htmlPath = path.join(dir, "report.html");
  const pdfPath = path.join(dir, "report.pdf");
  fs.writeFileSync(htmlPath, html);
  const electron = path.join(process.cwd(), "node_modules", ".bin", "electron");
  execFileSync(electron, [path.join(process.cwd(), "scripts", "pdf-from-html.cjs"), htmlPath, pdfPath], {
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" },
    timeout: 60000,
  });
  return fs.readFileSync(pdfPath);
}

/** Chromium printToPDF writes glyph ids. Each font's ToUnicode map turns them back into text. */
function extractPdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const objects = new Map<number, string>();
  for (const match of raw.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) {
    objects.set(Number(match[1]), inflateObject(match[2]));
  }
  const unicodeByFont = new Map<number, Map<string, string>>();
  for (const [num, body] of objects) {
    const link = body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (!link) continue;
    const cmap = objects.get(Number(link[1])) || "";
    if (cmap.includes("beginbfchar") || cmap.includes("beginbfrange")) unicodeByFont.set(num, parseToUnicode(cmap));
  }
  const resourceFont = new Map<string, number>();
  for (const match of raw.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) resourceFont.set(match[1], Number(match[2]));
  const content = [...objects.values()].find((body) => body.includes("Tj")) || "";
  let active = unicodeByFont.values().next().value || new Map<string, string>();
  let text = "";
  const tokens = content.split(/(?=\/F\d+\s+[0-9.]+\s+Tf)|(?=<[0-9A-Fa-f]+>\s*Tj)/);
  for (const token of tokens) {
    const font = token.match(/^\/(F\d+)\s+[0-9.]+\s+Tf/);
    if (font) {
      const fontObject = resourceFont.get(font[1]);
      const mapped = fontObject === undefined ? undefined : unicodeByFont.get(fontObject);
      if (mapped) active = mapped;
    }
    const glyph = token.match(/^<([0-9A-Fa-f]+)>\s*Tj/);
    if (!glyph) continue;
    const hex = glyph[1].toUpperCase();
    for (let i = 0; i < hex.length; i += 4) {
      text += active.get(hex.slice(i, i + 4).padStart(4, "0")) || "";
    }
  }
  return text;
}

function inflateObject(body: string): string {
  const start = body.indexOf("stream");
  if (start < 0) return body;
  const end = body.indexOf("endstream", start);
  if (end < 0) return body;
  let stream = body.slice(start + "stream".length, end);
  if (stream.startsWith("\r\n")) stream = stream.slice(2);
  else if (stream.startsWith("\n")) stream = stream.slice(1);
  try {
    return zlib.inflateSync(Buffer.from(stream, "latin1")).toString("latin1");
  } catch {
    return body;
  }
}

function parseToUnicode(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(match[1].toUpperCase().padStart(4, "0"), decodeUtf16(match[2]));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = parseInt(match[1], 16);
      const end = parseInt(match[2], 16);
      let dest = parseInt(match[3], 16);
      for (let code = start; code <= end; code += 1) {
        map.set(code.toString(16).toUpperCase().padStart(4, "0"), String.fromCodePoint(dest));
        dest += 1;
      }
    }
  }
  return map;
}

function decodeUtf16(hex: string): string {
  const bytes = hex.padStart(4, "0");
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    out += String.fromCharCode(parseInt(bytes.slice(i, i + 4), 16));
  }
  return out;
}
