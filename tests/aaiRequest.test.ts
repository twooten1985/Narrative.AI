import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTranscriptRequest } from "../src/services/aaiClient.ts";

describe("buildTranscriptRequest", () => {
  it("uses speaker labels and keyterms and never word_boost or a built-in summary", () => {
    const jail = buildTranscriptRequest({
      audioUrl: "https://cdn.example/audio",
      speakersExpected: 2,
      keyterms: ["lawyer", "bond"],
    });
    assert.equal(jail.speaker_labels, true);
    assert.equal(jail.speakers_expected, 2);
    assert.deepEqual(jail.keyterms_prompt, ["lawyer", "bond"]);
    assert.equal("word_boost" in jail, false);
    assert.equal("speech_understanding" in jail, false);
    assert.deepEqual(jail.speech_models, ["universal-3-5-pro", "universal-2"]);
  });

  it("adds the built-in summary only when a caller will read it", () => {
    const body = buildTranscriptRequest({ audioUrl: "https://cdn.example/audio", includeBuiltinSummary: true });
    assert.ok(body.speech_understanding);
  });
});
