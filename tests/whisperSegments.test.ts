import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planWhisperSegments, stitchWhisperSegments, wavPcm16ToFloat32 } from "../src/services/whisperSegments.ts";

describe("whisper segments", () => {
  it("splits a long recording and overlaps the next window", () => {
    const plans = planWhisperSegments(25 * 60 * 1000, 10 * 60 * 1000, 5000);
    assert.equal(plans.length, 3);
    assert.equal(plans[0].startMs, 0);
    assert.equal(plans[1].overlapMs, 5000);
    assert.equal(plans[1].startMs, plans[0].endMs - 5000);
    assert.equal(plans[plans.length - 1].endMs, 25 * 60 * 1000);
  });

  it("keeps a short recording as one segment", () => {
    const plans = planWhisperSegments(30_000, 10 * 60 * 1000, 5000);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].overlapMs, 0);
  });

  it("stitches timestamps and drops the overlapped repeat", () => {
    const stitched = stitchWhisperSegments([
      {
        index: 0,
        startMs: 0,
        overlapMs: 0,
        chunks: [{ text: "hello there", start: 1, end: 2 }],
      },
      {
        index: 1,
        startMs: 595_000,
        overlapMs: 5_000,
        chunks: [
          { text: "hello there", start: 1, end: 2 },
          { text: "after the overlap", start: 6, end: 7 },
        ],
      },
    ]);
    assert.equal(stitched.utterances.length, 2);
    assert.equal(stitched.utterances[0].start, 1000);
    assert.equal(stitched.utterances[1].start, 595_000 + 6000);
    assert.match(stitched.text, /hello there/);
    assert.match(stitched.text, /after the overlap/);
    assert.equal(stitched.text.includes("hello there hello there"), false);
    assert.ok(stitched.words.length >= 2);
  });

  it("reads samples after a data chunk that is not at byte 44", () => {
    const header = Buffer.alloc(12 + 8 + 4 + 8);
    header.write("RIFF", 0);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(4, 16);
    header.write("data", 24);
    header.writeUInt32LE(2, 28);
    const sample = Buffer.alloc(2);
    sample.writeInt16LE(16384, 0);
    const audio = wavPcm16ToFloat32(Buffer.concat([header, sample]));
    assert.equal(audio.length, 1);
    assert.ok(Math.abs(audio[0] - 0.5) < 0.01);
  });
});
