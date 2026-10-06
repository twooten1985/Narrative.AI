import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractFinalSummary, finalSummaryClipboard, markdownToPlain } from "../src/services/finalSummary.ts";

const REPORT = `## 1. Case Information
- **Case:** Example

## 2. Executive Summary
Short overview.

## Final Summary
Det. John Smith interviewed **Maria Lopez** about the blue car.

She stated, "I was home." The interview ended at 7:09 p.m.

## Not part of the summary
This heading is later and must not be copied.
`;

describe("final summary plain text", () => {
  it("extracts only the Final Summary and strips markdown and HTML", () => {
    const section = extractFinalSummary(REPORT);
    assert.match(section || "", /Maria Lopez/);
    assert.equal((section || "").includes("Not part of the summary"), false);
    const plain = markdownToPlain(`## Final Summary\n\n<p>Hello</p> **bold** and *italic* and [link](http://example.com)`);
    assert.equal(plain.includes("##"), false);
    assert.equal(plain.includes("**"), false);
    assert.equal(plain.includes("<p>"), false);
    assert.equal(plain.includes("http://example.com"), false);
    assert.match(plain, /Hello bold and italic and link/);
  });

  it("copies plain text with the AI footer and acknowledgement", () => {
    const copied = finalSummaryClipboard(REPORT, "AI use acknowledged by user on Oct 5, 2026 7:09 PM CDT.");
    assert.match(copied, /^Det\. John Smith interviewed Maria Lopez/);
    assert.match(copied, /AI-assisted summary/);
    assert.match(copied, /Oct 5, 2026 7:09 PM CDT/);
    assert.equal(copied.includes("##"), false);
    assert.equal(copied.includes("**"), false);
    assert.equal(copied.includes("Not part of the summary"), false);
    assert.equal(finalSummaryClipboard("## 2. Executive Summary\nOnly this."), "");
  });
});
