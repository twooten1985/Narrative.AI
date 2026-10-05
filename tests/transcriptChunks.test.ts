import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkTranscript, chunkTranscriptLines, estimateTokens } from "../src/services/transcriptChunks.ts";
import { transcriptLines } from "../src/services/reportPrompts.ts";

function utterance(startMin: number, text: string) {
  const start = startMin * 60 * 1000;
  return { speaker: "A", start, end: start + 1000, text, words: [{ text, confidence: 0.9 }] };
}

describe("chunkTranscript", () => {
  it("keeps a short transcript as one block", () => {
    const chunks = chunkTranscript({
      text: "short",
      utterances: [utterance(0, "hello"), utterance(1, "there")],
    });
    assert.equal(chunks.length, 1);
    assert.match(chunks[0].text, /Speaker A: hello/);
  });

  it("splits long transcripts on time and never splits an utterance", () => {
    const utterances = [];
    for (let minute = 0; minute < 80; minute += 5) {
      utterances.push(utterance(minute, "statement ".repeat(20)));
    }
    const lines = transcriptLines({ utterances });
    const chunks = chunkTranscriptLines(lines, { tokenLimit: 50, targetBlockMs: 25 * 60 * 1000 });
    assert.ok(chunks.length >= 3);
    const joined = chunks.map((c) => c.text).join("\n");
    for (const line of lines) assert.equal(joined.includes(line.line), true);
    for (const chunk of chunks) {
      assert.ok(chunk.endMs >= chunk.startMs);
      assert.ok(chunk.utteranceCount >= 1);
      assert.equal(estimateTokens(chunk.text), chunk.estimatedTokens);
    }
  });

  it("splits a six-hour recording into blocks even when the text is under the token limit", () => {
    const utterances = [];
    for (let minute = 0; minute <= 360; minute += 20) utterances.push(utterance(minute, "short statement"));
    const chunks = chunkTranscript({ utterances });
    assert.ok(chunks.length >= 8);
    const joined = chunks.map((c) => c.text).join("\n");
    assert.match(joined, /short statement/);
    for (const chunk of chunks) assert.ok(chunk.endMs - chunk.startMs <= 25 * 60 * 1000 + 1000);
  });

  it("returns one raw block when a long transcript has no utterances", () => {
    const text = "word ".repeat(500);
    const chunks = chunkTranscript({ text }, null, { tokenLimit: 10 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, text.trim() ? text : text);
    assert.equal(chunks[0].rangeLabel, "full recording");
  });
});
