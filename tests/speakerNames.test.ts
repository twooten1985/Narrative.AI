import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMergeMessages, buildReportMessages, formatTranscriptForLLM } from "../src/services/reportPrompts.ts";
import { speakerNameInstructions, suggestSpeakerNames } from "../src/services/speakerNames.ts";

const interview = {
  utterances: [
    { speaker: "A", text: "I am Detective John Smith. State your name for the record." },
    { speaker: "B", text: "Maria Lopez." },
    { speaker: "A", text: "I'm going home after this." },
    { speaker: "C", text: "The other guy is named Robert." },
  ],
};

describe("speaker name suggestions", () => {
  it("uses a speaker's own introduction and a direct answer to state your name", () => {
    const suggestions = suggestSpeakerNames(interview);
    const bySpeaker = Object.fromEntries(suggestions.map((item) => [item.speaker, item.name]));
    assert.equal(bySpeaker.A, "Detective John Smith");
    assert.equal(bySpeaker.B, "Maria Lopez");
    assert.equal(bySpeaker.C, undefined);
    assert.match(suggestions.find((item) => item.speaker === "A")?.evidence || "", /Detective John Smith/);
  });

  it("does not treat ordinary sentences as names", () => {
    const suggestions = suggestSpeakerNames({
      utterances: [{ speaker: "A", text: "I'm going home. This is a recording." }],
    });
    assert.equal(suggestions.length, 0);
  });

  it("puts a saved name on the transcript line and tells the model not to invent one", () => {
    const block = formatTranscriptForLLM({
      utterances: [{ speaker: "A", start: 0, end: 1000, text: "I was there." }],
    }, { A: "Det. John Smith" });
    assert.match(block, /Det\. John Smith:/);
    assert.equal(block.includes("Speaker A"), false);

    const built = buildReportMessages({
      reportType: "Suspect Interview",
      transcriptBlock: block,
      speakers: ["A", "B"],
      speakerLabels: { A: "Det. John Smith" },
      speakerSuggestions: [{ speaker: "B", name: "Maria Lopez", evidence: "Maria Lopez." }],
      caseInfo: { reportingOfficer: "Det. John Smith" },
    });
    assert.match(built.system, /## Final Summary/);
    assert.match(built.system, /Do not invent a personal name/);
    assert.match(built.user, /Speaker A is Det\. John Smith/);
    assert.match(built.user, /Do not write "Speaker A"/);
    assert.match(built.user, /Maria Lopez/);
    assert.match(built.user, /reporting officer as Det\. John Smith/);

    const merged = buildMergeMessages({
      reportType: "Suspect Interview",
      partials: [{ rangeLabel: "00:00:00–00:10:00", text: "partial" }],
      speakers: ["A"],
      speakerLabels: { A: "Det. John Smith" },
    });
    assert.match(merged.user, /## Final Summary/);
    assert.match(merged.user, /whole recording/);
    assert.equal(speakerNameInstructions({ speakers: ["B"] }).includes("Do not invent a name"), true);
  });
});
