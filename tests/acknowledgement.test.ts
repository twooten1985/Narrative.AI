import assert from "node:assert/strict";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { Packer } from "docx";
import { formatAiAcknowledgement, formatReportFooter } from "../src/services/audit.ts";
import { buildReportDocument } from "../src/services/reportDocx.ts";

const LABEL = "AI use acknowledged by user on Oct 5, 2026 7:09 PM CDT.";

describe("AI acknowledgement", () => {
  it("formats the local time with the timezone abbreviation", () => {
    const label = formatAiAcknowledgement("2026-10-06T00:09:00.000Z", "America/Chicago");
    assert.equal(label, LABEL);
  });

  it("keeps the acknowledgement between the AI disclaimer and the audit line", () => {
    const footer = formatReportFooter({
      model: "claude-sonnet-4-6",
      requestId: "req_1",
      transcriptId: "tr_1",
      generatedAt: "2026-10-06T00:09:00.000Z",
      aiAcknowledgedLabel: LABEL,
    });
    const lines = footer.split("\n");
    assert.match(lines[0], /AI-assisted summary/);
    assert.equal(lines[1], LABEL);
    assert.match(lines[2], /Model: claude-sonnet-4-6/);
    const without = formatReportFooter({ model: "claude-sonnet-4-6" });
    assert.equal(without.includes("acknowledged"), false);
  });

  it("writes the acknowledgement into the DOCX body", async () => {
    const buffer = await Packer.toBuffer(buildReportDocument({
      caseName: "Interview",
      recordingName: "room.mp3",
      reportMarkdown: "## Final Summary\nMaria Lopez denied being there.",
      reportDate: "2026-10-05",
      auditLine: "Model: claude-sonnet-4-6",
      acknowledgement: LABEL,
      speakerLabels: { A: "Det. John Smith" },
      utterances: [{ speaker: "A", startMs: 0, text: "State your name." }],
    }));
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")?.async("string");
    assert.match(xml || "", /AI use acknowledged by user on Oct 5, 2026 7:09 PM CDT/);
    assert.match(xml || "", /Det\. John Smith/);
    assert.match(xml || "", /AI-assisted summary/);
  });
});
