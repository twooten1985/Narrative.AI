import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BASE_SYSTEM_PROMPT, FIRST_HEADING } from "../src/services/reportPrompts.ts";
import { generateInvestigativeReport, TRUNCATION_WARNING, type ChatFn } from "../src/services/reportPipeline.ts";

const CLEAN = `## 1. Case Information
- **Case:** Example
## 2. Executive Summary
The subject stated the car was blue.`;

function poisoned() {
  return `<reasoning>The user wants a report. ${BASE_SYSTEM_PROMPT}</reasoning>
Here is the report:
${CLEAN}`;
}

function utterance(index: number) {
  const start = index * 10 * 60 * 1000;
  const text = `statement number ${index} `.repeat(30);
  return { speaker: index % 2 === 0 ? "A" : "B", start, end: start + 4000, text };
}

describe("generateInvestigativeReport", () => {
  it("returns a clean report when the gateway echoes instructions inside reasoning", async () => {
    const chat: ChatFn = async () => ({
      content: poisoned(),
      model: "claude-sonnet-4-6",
      requestId: "req_clean",
      finishReason: "stop",
    });
    const result = await generateInvestigativeReport({
      reportType: "Suspect Interview",
      transcript: { id: "tr_1", text: "hello", utterances: [utterance(0)] },
      model: "claude-sonnet-4-6",
      chat,
    });
    assert.equal(result.text.startsWith(FIRST_HEADING), true);
    assert.equal(result.text.includes("<reasoning>"), false);
    assert.equal(result.text.includes("You write investigative reports"), false);
    assert.equal(result.text.includes("Here is the report"), false);
    assert.equal(result.requestId, "req_clean");
    assert.equal(result.transcriptId, "tr_1");
    assert.equal(result.partCount, 1);
    assert.equal(result.truncated, false);
  });

  it("summarizes each block then merges, and still strips echoed instructions", async () => {
    let calls = 0;
    const chat: ChatFn = async (args) => {
      calls += 1;
      const user = args.messages.find((m) => m.role === "user")?.content || "";
      assert.match(args.messages[0].content, /Return only the report/);
      assert.equal(user.includes("word_boost"), false);
      return {
        content: poisoned(),
        model: "gpt-oss-120b",
        requestId: calls === 1 ? "req_part" : "req_merge",
        finishReason: "stop",
      };
    };
    const result = await generateInvestigativeReport({
      reportType: "Jail Phone Calls",
      transcript: { id: "tr_long", utterances: [0, 1, 2, 3].map(utterance) },
      model: "claude-sonnet-4-6",
      tokenLimit: 80,
      chat,
    });
    assert.ok(result.partCount >= 2);
    assert.equal(calls, result.partCount + 1);
    assert.equal(result.requestId, "req_merge");
    assert.equal(result.text.startsWith(FIRST_HEADING), true);
    assert.equal(result.text.includes("<reasoning>"), false);
    assert.equal(result.text.includes("You write investigative reports"), false);
  });

  it("continues a report that stopped on length and keeps the final section", async () => {
    let round = 0;
    const chat: ChatFn = async (args) => {
      round += 1;
      assert.equal(args.maxTokens, 16000);
      if (round === 1) {
        return { content: CLEAN, model: "claude-sonnet-4-6", requestId: "req_cut", finishReason: "length" };
      }
      assert.match(args.messages.map((m) => m.content).join("\n"), /Continue the report from the cutoff/);
      return {
        content: "## 9. Unclear Audio\nFINAL-SECTION-MARKER",
        model: "claude-sonnet-4-6",
        requestId: "req_tail",
        finishReason: "stop",
      };
    };
    const result = await generateInvestigativeReport({
      reportType: "Witness Interview",
      transcript: { id: "tr_cut", utterances: [utterance(0)] },
      model: "claude-sonnet-4-6",
      chat,
    });
    assert.equal(result.truncated, false);
    assert.match(result.text, /FINAL-SECTION-MARKER/);
    assert.equal(result.text.includes(TRUNCATION_WARNING), false);
    assert.equal(result.requestId, "req_tail");
  });

  it("asks gpt-oss for a larger token budget because reasoning shares max_tokens", async () => {
    const chat: ChatFn = async (args) => {
      assert.equal(args.maxTokens, 32000);
      return { content: CLEAN, model: "gpt-oss-120b", requestId: "req_oss", finishReason: "stop" };
    };
    const result = await generateInvestigativeReport({
      reportType: "Suspect Interview",
      transcript: { id: "tr_oss", utterances: [utterance(0)] },
      model: "gpt-oss-120b",
      chat,
    });
    assert.equal(result.truncated, false);
    assert.match(result.text, /car was blue/);
  });

  it("adds a truncation warning when every continuation still stops on length", async () => {
    const chat: ChatFn = async () => ({
      content: CLEAN,
      model: "claude-sonnet-4-6",
      requestId: "req_cut",
      finishReason: "length",
    });
    const result = await generateInvestigativeReport({
      reportType: "Witness Interview",
      transcript: { id: "tr_cut", utterances: [utterance(0)] },
      model: "claude-sonnet-4-6",
      chat,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.text.includes(TRUNCATION_WARNING), true);
  });
});
