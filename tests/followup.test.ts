// 6.1.6 follow-up tests: summary timestamps checked against the transcript, header split, review wording,
// pronoun rule, transcript gaps, footer constants. Synthetic data only.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { Packer } from "docx";
import { JSDOM } from "jsdom";
import { buildReportDocument } from "../src/services/reportDocx.ts";
import { headerRows, markShortParagraphs, summaryServiceLine, MACHINE_LABEL, REPORT_CSS, type ReportExportInput } from "../src/services/reportExport.ts";
import { BASE_SYSTEM_PROMPT, transcriptLines } from "../src/services/reportPrompts.ts";
import { generateInvestigativeReport } from "../src/services/reportPipeline.ts";
import { findGaps, findGenderedPronouns, gapLabel, segmentUtterances, sortUnclearAudio, verifyTimestamps, type TimedSegment } from "../src/services/timestamps.ts";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
const { buildPrintableReportHtml } = await import("../src/services/reportHtml.ts");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfOptions = (await import("../electron/pdfOptions.cjs")) as any;

const SEGMENTS: TimedSegment[] = [
  { speaker: "A", startMs: 8_000, endMs: 14_000, text: "This is Detective Alvarez and I'm here with Jordan Ellis." },
  { speaker: "B", startMs: 99_000, endMs: 110_000, text: "Average height, dark hooded sweatshirt. I couldn't see the face." },
  { speaker: "A", startMs: 135_000, endMs: 140_000, text: "Did you see anything in the person's hands?" },
  { speaker: "B", startMs: 270_000, endMs: 276_000, text: "I didn't see anything in his hands, but it was dark." },
  { speaker: "B", startMs: 400_000, endMs: 406_000, text: "I wasn't sure it was a break-in." },
  { speaker: "B", startMs: 500_000, endMs: 505_000, text: "I wasn't sure it was a break-in." },
];

describe("timestamp verification", () => {
  it("keeps a correct time and quote", () => {
    const r = verifyTimestamps('At [00:01:39] Ellis said "Average height, dark hooded sweatshirt".', SEGMENTS);
    assert.equal(r.cited, 1);
    assert.equal(r.verified, 1);
    assert.equal(r.corrected, 0);
    assert.equal(r.unverified, 0);
    assert.match(r.text, /\[00:01:39\]/);
  });

  it("corrects a wrong time when the quoted words are found at one other place (the reported 00:02:15 case)", () => {
    const r = verifyTimestamps('- **[00:02:15] Ellis:** "Average height, dark hooded sweatshirt."', SEGMENTS);
    assert.equal(r.corrected, 1);
    assert.equal(r.unverified, 0);
    assert.match(r.text, /\*\*\[00:01:39\] Ellis/);
    assert.deepEqual(r.changes.map((c) => [c.from, c.to]), [["00:02:15", "00:01:39"]]);
  });

  it("corrects a quote cited before it (quote first, time after)", () => {
    const r = verifyTimestamps('Ellis: "I didn\'t see anything in his hands, but it was dark." [00:06:41]', SEGMENTS);
    assert.match(r.text, /\[00:04:30\]/);
    assert.equal(r.corrected, 1);
  });

  it("marks a time that is not in the transcript as UNVERIFIED", () => {
    const r = verifyTimestamps("At [05:00:00] a statement was made.", SEGMENTS);
    assert.equal(r.unverified, 1);
    assert.match(r.text, /\[05:00:00 UNVERIFIED\]/);
    assert.match(r.flagged[0].reason, /outside the transcript/);
  });

  it("marks a quote that is nowhere in the transcript as UNVERIFIED instead of guessing", () => {
    const r = verifyTimestamps('At [00:01:39] Ellis said "the driver was wearing a red scarf and glasses".', SEGMENTS);
    assert.equal(r.unverified, 1);
    assert.match(r.text, /\[00:01:39 UNVERIFIED\]/);
  });

  it("gives a quotation that sits right before the next time to that time", () => {
    const r = verifyTimestamps(`At [00:02:15] the detective asked about the hands. Ellis said "I didn\x27t see anything in his hands, but it was dark." [00:04:30]`, SEGMENTS);
    assert.equal(r.unverified, 0);
    assert.equal(r.verified, 2);
    assert.equal(r.corrected, 0);
  });

  it("marks a time with no speech at that moment as UNVERIFIED", () => {
    const r = verifyTimestamps("At [00:03:00] something happened.", SEGMENTS);
    assert.equal(r.unverified, 1);
    assert.match(r.flagged[0].reason, /no speech/);
  });

  it("does not guess when the same quote appears at several equally distant places", () => {
    const r = verifyTimestamps('At [00:07:30] Ellis said "I wasn\'t sure it was a break-in".', SEGMENTS);
    assert.equal(r.unverified, 1);
    assert.match(r.text, /\[00:07:30 UNVERIFIED\]/);
  });

  it("accepts a quote that is near its time even when it repeats elsewhere", () => {
    const r = verifyTimestamps('At [00:08:20] Ellis said "I wasn\'t sure it was a break-in".', SEGMENTS);
    assert.equal(r.unverified, 0);
    assert.equal(r.corrected, 0);
  });

  it("is idempotent and clears a stale marker when the time now checks out", () => {
    const first = verifyTimestamps('At [00:02:15] Ellis said "Average height, dark hooded sweatshirt".', SEGMENTS);
    const second = verifyTimestamps(first.text, SEGMENTS);
    assert.equal(second.text, first.text);
    const stale = verifyTimestamps('At [00:01:39 UNVERIFIED] Ellis said "Average height, dark hooded sweatshirt".', SEGMENTS);
    assert.match(stale.text, /\[00:01:39\] Ellis/);
    const flagged = verifyTimestamps("At [05:00:00] x.", SEGMENTS);
    assert.equal(verifyTimestamps(flagged.text, SEGMENTS).text, flagged.text);
  });

  it("handles curly quotes and ellipses", () => {
    const r = verifyTimestamps("At [00:02:15] Ellis said \u201cAverage height\u2026 couldn\u2019t see the face\u201d.", SEGMENTS);
    assert.equal(r.corrected, 1);
    assert.match(r.text, /\[00:01:39\]/);
  });
});

describe("segments and gaps", () => {
  const words = Array.from({ length: 120 }, (_, i) => ({ text: i % 20 === 19 ? `w${i}.` : `w${i}`, start: 10_000 + i * 500, end: 10_000 + i * 500 + 400, confidence: 0.9 }));
  const long = { speaker: "B", start: 10_000, end: 70_000, text: words.map((w) => w.text).join(" "), words };

  it("splits a long answer into segments of at most 30 seconds, each with its own start", () => {
    const segs = segmentUtterances([long]);
    assert.ok(segs.length >= 2);
    for (const s of segs) assert.ok(s.endMs - s.startMs <= 31_000);
    assert.equal(segs[0].startMs, 10_000);
    assert.ok(segs[1].startMs > 20_000);
    assert.equal(segs.map((s) => s.text).join(" "), long.text);
  });

  it("leaves a short utterance as one segment", () => {
    assert.equal(segmentUtterances([{ speaker: "A", start: 1000, end: 5000, text: "Short.", words: [{ text: "Short.", start: 1000, end: 5000 }] }]).length, 1);
  });

  it("gives the model a real time for every part of a long answer, and marks long silences", () => {
    const lines = transcriptLines({ utterances: [{ speaker: "A", start: 1000, end: 4000, text: "Hello there." }, long, { speaker: "A", start: 200_000, end: 203_000, text: "Later." }] });
    const spoken = lines.filter((l) => /^\[\d\d:\d\d:\d\d\]/.test(l.line));
    assert.ok(spoken.length >= 4);
    assert.ok(lines.some((l) => /No speech transcribed from 00:01:09 to 00:03:20/.test(l.line)));
    assert.ok(spoken.every((l) => /^\[\d\d:\d\d:\d\d\] /.test(l.line)));
  });

  it("finds gaps over 60 seconds, including leading and trailing ones, and words them clearly", () => {
    const gaps = findGaps([{ startMs: 5_000, endMs: 10_000 }, { startMs: 100_000, endMs: 110_000 }, { startMs: 120_000, endMs: 130_000 }], { minMs: 60_000, durationMs: 250_000 });
    assert.deepEqual(gaps.map(gapLabel), ["No speech transcribed from 00:00:10 to 00:01:40", "No speech transcribed from 00:02:10 to 00:04:10"]);
    assert.deepEqual(findGaps([{ startMs: 0, endMs: 1000 }, { startMs: 60_500, endMs: 61_000 }], { minMs: 60_000 }), []);
  });
});

describe("generated report is checked against the transcript", () => {
  it("corrects a wrong time the model wrote and reports the counts", async () => {
    const utterances = [
      { speaker: "A", start: 8_000, end: 14_000, text: "Please state your name." },
      { speaker: "B", start: 99_000, end: 110_000, text: "Average height, dark hooded sweatshirt." },
    ];
    const chat = async () => ({ content: '## 1. Case Information\nAt [00:02:15] the witness stated, "Average height, dark hooded sweatshirt."', model: "m", requestId: "r", finishReason: "stop" });
    const result = await generateInvestigativeReport({
      transcript: { utterances, text: "x", id: "tr-1" },
      reportType: "Witness Interview",
      model: "m",
      chat: chat as any,
    } as any);
    assert.match(result.text, /\[00:01:39\]/);
    assert.equal(result.timestampCheck?.corrected, 1);
    assert.equal(result.timestampCheck?.unverified, 0);
  });
});

describe("report header, review wording and footer", () => {
  const base: ReportExportInput = {
    caseNumber: "26-104417", sourceFileName: "a.m4a", appVersion: "6.1.6", reportId: "NAR-1", markdown: "## 1. Case Information\n- ok",
    service: "AssemblyAI", model: "claude-sonnet-4-6", sourceSha256: "ab".repeat(32),
  };

  it("splits 'Written by' into Transcription and Summary rows", () => {
    const rows = headerRows(base);
    assert.equal(rows.some((r) => r.label === "Written by"), false);
    assert.deepEqual(rows.find((r) => r.label === "Transcription"), { label: "Transcription", value: "AssemblyAI" });
    assert.equal(rows.find((r) => r.label === "Summary")?.value, "AssemblyAI LLM Gateway, model claude-sonnet-4-6");
    assert.equal(summaryServiceLine({ service: "Local Ollama on this PC", model: "llama3" }), "Local Ollama, model llama3");
    assert.equal(summaryServiceLine({ service: "Google Gemini", model: "gemini-2.5-pro" }), "Google Gemini, model gemini-2.5-pro");
    const timestamped = headerRows({ ...base, timestampCheck: { cited: 5, verified: 5, corrected: 1, unverified: 0 } });
    assert.match(timestamped.find((r) => r.label === "Timestamp check")?.value || "", /5 cited.*1 corrected.*0 unverified/);
  });

  it("shows the machine-generated box on page one and 'Not yet reviewed' only once, in the sign-off", () => {
    const html = buildPrintableReportHtml({ report: base });
    const before = html.slice(0, html.indexOf("Reviewer sign-off"));
    assert.ok(before.includes(MACHINE_LABEL));
    assert.equal(before.includes("Not yet reviewed"), false);
    assert.equal((html.match(/Not yet reviewed by a person/g) || []).length, 1);
    assert.ok(html.indexOf("Not yet reviewed by a person") > html.indexOf("Reviewer sign-off"));
  });

  it("DOCX has the same: no review line on page one, one in the sign-off", async () => {
    const zip = await JSZip.loadAsync(await Packer.toBuffer(buildReportDocument({ report: base })));
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.equal((xml.match(/Not yet reviewed by a person/g) || []).length, 1);
    assert.ok(xml.indexOf("Not yet reviewed") > xml.indexOf("Reviewer sign-off"));
    assert.ok(xml.includes("Transcription") && xml.includes("AssemblyAI LLM Gateway"));
  });

  it("draws gap rows and UNVERIFIED markers in HTML and DOCX", async () => {
    const report: ReportExportInput = {
      ...base,
      markdown: "## 3. Narrative\nAt [05:00:00 UNVERIFIED] something.",
      transcript: [
        { speaker: "A", startMs: 1000, text: "Hello." },
        { speaker: "", startMs: 10_000, endMs: 100_000, kind: "gap", text: "No speech transcribed from 00:00:10 to 00:01:40" },
        { speaker: "A", startMs: 100_000, text: "Back." },
      ],
    };
    const html = buildPrintableReportHtml({ report });
    assert.match(html, /class="flag unverified">\[05:00:00 UNVERIFIED\]/);
    assert.match(html, /<tr class="gap">.*No speech transcribed from 00:00:10 to 00:01:40/);
    assert.match(html, /1 stretch of more than 60 seconds/);
    const zip = await JSZip.loadAsync(await Packer.toBuffer(buildReportDocument({ report })));
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.ok(xml.includes("No speech transcribed from 00:00:10 to 00:01:40"));
    assert.ok(xml.includes("[05:00:00 UNVERIFIED]"));
  });

  it("the prompt tells the model to avoid gendered pronouns and to cite only printed times", () => {
    assert.match(BASE_SYSTEM_PROMPT, /Do not use gendered pronouns \(he, she, him, her, his, hers, himself, herself\)/);
    assert.match(BASE_SYSTEM_PROMPT, /"the witness"/);
    assert.match(BASE_SYSTEM_PROMPT, /Never calculate, round, estimate or invent a time/);
  });

  it("the PDF footer keeps a 0.5 inch clear bottom margin and a hash font of at least 7 pt", () => {
    const options = pdfOptions.default?.buildPdfOptions ? pdfOptions.default.buildPdfOptions({ left: "L", hashLine: "H" }) : pdfOptions.buildPdfOptions({ left: "L", hashLine: "H" });
    const tpl: string = options.footerTemplate;
    assert.match(tpl, /padding-bottom:0\.5in/);
    const sizes = [...tpl.matchAll(/font-size:([\d.]+)pt/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length >= 2 && sizes.every((s) => s >= 7), `footer font sizes ${sizes.join(",")}`);
    assert.ok(options.margins.bottom >= 1);
    assert.ok(fs.existsSync("scripts/render-sample-report.ts"));
  });
});
describe("wording, Unclear Audio order and the printed UNVERIFIED marker", () => {
  const UNSORTED = [
    "## 4. Key Statements", "- keep", "",
    "## 5. Unclear Audio",
    "- [00:09:10] later passage",
    "- [00:02:05] The street name was unclear.",
    "  continuation of the second item",
    "- no time on this one",
    "- **[00:05:00]** middle passage",
    "",
    "## 6. Follow-Up Items", "- [00:00:01] not part of the list",
  ].join("\n");

  it("sorts the Unclear Audio items by time and leaves everything else alone", () => {
    const out = sortUnclearAudio(UNSORTED);
    const lines = out.split("\n");
    const start = lines.indexOf("## 5. Unclear Audio");
    assert.deepEqual(lines.slice(start + 1, start + 6), [
      "- [00:02:05] The street name was unclear.",
      "  continuation of the second item",
      "- **[00:05:00]** middle passage",
      "- [00:09:10] later passage",
      "- no time on this one",
    ]);
    assert.ok(out.endsWith("- [00:00:01] not part of the list"));
    assert.ok(out.startsWith("## 4. Key Statements\n- keep\n"));
    assert.equal(sortUnclearAudio(out), out);
    assert.equal(sortUnclearAudio("## 1. Case\n- a"), "## 1. Case\n- a");
  });

  it("renumbers a numbered Unclear Audio list", () => {
    const out = sortUnclearAudio("## Unclear Audio\n1. [00:04:00] b\n2. [00:01:00] a");
    assert.equal(out, "## Unclear Audio\n1. [00:01:00] a\n2. [00:04:00] b");
  });

  it("the HTML and DOCX outputs list Unclear Audio in time order", async () => {
    const report: ReportExportInput = { caseNumber: "1", sourceFileName: "a.m4a", appVersion: "6.1.6", reportId: "NAR-1", markdown: UNSORTED, service: "AssemblyAI", model: "m" };
    const html = buildPrintableReportHtml({ report });
    assert.ok(html.indexOf("00:02:05") < html.indexOf("00:05:00") && html.indexOf("00:05:00") < html.indexOf("00:09:10"));
    const zip = await JSZip.loadAsync(await Packer.toBuffer(buildReportDocument({ report })));
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.ok(xml.indexOf("00:02:05") < xml.indexOf("00:05:00") && xml.indexOf("00:05:00") < xml.indexOf("00:09:10"));
  });

  it("the pipeline sorts Unclear Audio and counts gendered pronouns outside quotes", async () => {
    const utterances = [{ speaker: "B", start: 99_000, end: 110_000, text: "Average height." }, { speaker: "B", start: 130_000, end: 140_000, text: "Something else." }];
    const md = '## 3. Narrative\nAt [00:01:39] the witness said he saw a person. They said "she ran". \n\n## 5. Unclear Audio\n- [00:02:10] b\n- [00:01:39] a\n';
    const chat = async () => ({ content: md, model: "m", requestId: "r", finishReason: "stop" });
    const result = await generateInvestigativeReport({ transcript: { utterances, text: "x", id: "tr-2" }, reportType: "Witness Interview", model: "m", chat: chat as any } as any);
    assert.ok(result.text.indexOf("[00:01:39] a") < result.text.indexOf("[00:02:10] b"));
    assert.deepEqual(result.pronounCheck, { count: 1, words: ["he"] });
  });

  it("finds gendered pronouns outside quotes only, and shows a Wording check row when there are some", () => {
    assert.deepEqual(findGenderedPronouns('The witness said "he ran" and they left. His car, her coat.'), { count: 2, words: ["her", "his"] });
    assert.deepEqual(findGenderedPronouns("The witness said they saw the Hendersons. Ellis agreed, and the detective left."), { count: 0, words: [] });
    const base: ReportExportInput = { caseNumber: "1", sourceFileName: "a.m4a", appVersion: "6.1.6", reportId: "NAR-1", markdown: "x" };
    assert.equal(headerRows(base).some((r) => r.label === "Wording check"), false);
    const row = headerRows({ ...base, pronounCheck: { count: 2, words: ["he", "his"] } }).find((r) => r.label === "Wording check");
    assert.match(row?.value || "", /2 gendered pronouns outside quotes \(he, his\)/);
  });

  it("the prompt asks for 'the witness', a role or singular they after the first mention, and time-ordered Unclear Audio", () => {
    assert.match(BASE_SYSTEM_PROMPT, /after that, use "the witness"/i);
    assert.match(BASE_SYSTEM_PROMPT, /singular "they"/);
    assert.match(BASE_SYSTEM_PROMPT, /Ellis stated that Ellis heard glass breaking/);
    assert.match(BASE_SYSTEM_PROMPT, /Unclear Audio section, list the items in time order/);
  });

  it("styles the UNVERIFIED marker so it survives black-and-white printing (bold, heavy outline) in HTML and DOCX", async () => {
    const css = REPORT_CSS.match(/\.flag\.unverified \{[^}]*\}/)?.[0] || "";
    assert.match(css, /font-weight: 800/);
    assert.match(css, /border: 1\.5pt solid #000/);
    assert.match(css, /outline: 0\.75pt solid #000/);
    const report: ReportExportInput = { caseNumber: "1", sourceFileName: "a.m4a", appVersion: "6.1.6", reportId: "NAR-1", markdown: "## 3. N\nAt [00:04:50 UNVERIFIED] x.", service: "AssemblyAI", model: "m" };
    const zip = await JSZip.loadAsync(await Packer.toBuffer(buildReportDocument({ report })));
    const xml = await zip.file("word/document.xml")!.async("string");
    const run = xml.match(/<w:r>(?:(?!<\/w:r>).)*\[00:04:50 UNVERIFIED\](?:(?!<\/w:r>).)*<\/w:r>/s)?.[0] || "";
    assert.match(run, /<w:b\/>/);
    assert.match(run, /w:val="double"/);
  });

  it("keeps short paragraphs on one page and asks for 3 lines at each end of long ones", () => {
    const html = markShortParagraphs(`<p>short one</p><p>${"word ".repeat(200)}</p>`);
    assert.match(html, /<p class="short">short one<\/p>/);
    assert.equal((html.match(/class="short"/g) || []).length, 1);
    assert.match(REPORT_CSS, /\.content p\.short \{ break-inside: avoid/);
    assert.match(REPORT_CSS, /\.content p, \.content li \{ orphans: 3; widows: 3; \}/);
    const page = buildPrintableReportHtml({ report: { caseNumber: "1", sourceFileName: "a.m4a", appVersion: "6.1.6", reportId: "NAR-1", markdown: "## 2. Executive Summary\nShort paragraph." } });
    assert.match(page, /<p class="short">Short paragraph\.<\/p>/);
  });
});
