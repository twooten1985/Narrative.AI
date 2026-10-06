import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTranscriptForLLM, hhmmss, transcriptLines } from "../src/services/reportPrompts.ts";

describe("transcript formatting", () => {
  it("labels speakers and timestamps", () => {
    const lines = transcriptLines({
      utterances: [{
        speaker: "A",
        start: 65000,
        end: 70000,
        text: "I was home",
        words: [
          { text: "I", confidence: 0.9 },
          { text: "was", confidence: 0.2 },
          { text: "home", confidence: 0.8 },
        ],
      }],
    }, { A: "Det. Smith" });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].line, "[00:01:05] Det. Smith: I [unclear: was] home");
    const unlabeled = transcriptLines({
      utterances: [{ speaker: "B", start: 1000, end: 2000, text: "I do not know" }],
    });
    assert.equal(unlabeled[0].line, "[00:00:01] Speaker B: I do not know");
    assert.equal(hhmmss(65000), "00:01:05");
  });

  it("falls back to raw text when there are no utterances", () => {
    assert.equal(formatTranscriptForLLM({ text: "plain transcript" }), "plain transcript");
    assert.equal(transcriptLines({ text: "plain transcript" }).length, 0);
  });
});
