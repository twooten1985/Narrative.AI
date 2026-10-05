import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BASE_SYSTEM_PROMPT, TIMELINE_FIRST_HEADING } from "../src/services/reportPrompts.ts";
import { generateCaseTimeline, groupTimelineBlocks, type TimelineSource } from "../src/services/timelinePipeline.ts";
import { TRUNCATION_WARNING, type ChatFn } from "../src/services/reportPipeline.ts";

const CLEAN = `## 1. Case Overview
Two recordings describe the same evening.`;

function poisoned() {
  return `<reasoning>${BASE_SYSTEM_PROMPT}</reasoning>\nHere is the report:\n${CLEAN}`;
}

describe("case timeline", () => {
  it("groups blocks that would exceed the token limit", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => `recording ${i} ${"word ".repeat(40)}`);
    const groups = groupTimelineBlocks(blocks, 30);
    assert.ok(groups.length >= 2);
    assert.equal(groups.flat().length, blocks.length);
  });

  it("merges parts and strips echoed instructions", async () => {
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      return { content: poisoned(), model: "claude-sonnet-4-6", requestId: calls === 1 ? "req_part" : "req_merge", finishReason: "stop" };
    };
    const sources: TimelineSource[] = Array.from({ length: 4 }, (_, i) => ({
      name: `call-${i}.mp3`,
      summary: "word ".repeat(80),
      preview: "Speaker A: hello",
      transcriptId: `tr_${i}`,
    }));
    const result = await generateCaseTimeline({
      sources,
      model: "claude-sonnet-4-6",
      tokenLimit: 40,
      chat,
    });
    assert.ok(result.partCount >= 2);
    assert.equal(calls, result.partCount + 1);
    assert.equal(result.requestId, "req_merge");
    assert.equal(result.text.startsWith(TIMELINE_FIRST_HEADING), true);
    assert.equal(result.text.includes("<reasoning>"), false);
    assert.equal(result.text.includes("You write investigative reports"), false);
    assert.deepEqual(result.transcriptIds, ["tr_0", "tr_1", "tr_2", "tr_3"]);
  });

  it("adds the truncation warning when a part hits the length limit", async () => {
    const chat: ChatFn = async () => ({
      content: CLEAN,
      model: "claude-sonnet-4-6",
      requestId: "req_cut",
      finishReason: "length",
    });
    const result = await generateCaseTimeline({
      sources: [{ name: "one.mp3", summary: "Short." }],
      model: "claude-sonnet-4-6",
      chat,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.partCount, 1);
    assert.equal(result.text.includes(TRUNCATION_WARNING), true);
  });
});
