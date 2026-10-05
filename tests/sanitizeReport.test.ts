import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BASE_SYSTEM_PROMPT, FIRST_HEADING } from "../src/services/reportPrompts.ts";
import { sanitizeReport } from "../src/services/sanitizeReport.ts";
import { cleanStoredText } from "../src/services/cleanReports.ts";

const REPORT = `## 1. Case Information
- **Case:** Example
## 2. Executive Summary
The subject stated the car was blue.`;

describe("sanitizeReport", () => {
  it("drops reasoning blocks, echoed instructions, and preambles", () => {
    const raw = `<reasoning>The user wants a report. ${BASE_SYSTEM_PROMPT}</reasoning>
Here is the report:
${REPORT}
Let me know if you need anything else.`;
    const cleaned = sanitizeReport(raw, {
      firstHeading: FIRST_HEADING,
      instructionText: BASE_SYSTEM_PROMPT,
    });
    assert.equal(cleaned.startsWith(FIRST_HEADING), true);
    assert.equal(cleaned.includes("<reasoning>"), false);
    assert.equal(cleaned.includes("You write investigative reports"), false);
    assert.equal(cleaned.includes("Here is the report"), false);
    assert.equal(cleaned.includes("Let me know"), false);
    assert.match(cleaned, /car was blue/);
  });

  it("keeps an unclosed reasoning block's report and strips harmony markers", () => {
    const raw = `<think>restating the task
<|channel|>final<|message|>
${REPORT}`;
    const cleaned = sanitizeReport(raw, { firstHeading: FIRST_HEADING });
    assert.equal(cleaned.startsWith(FIRST_HEADING), true);
    assert.equal(cleaned.includes("<|"), false);
    assert.equal(cleaned.includes("<think>"), false);
  });

  it("does not drop the rest of a long report when assistantfinal appears after the preamble", () => {
    const ending = "## 9. Unclear Audio\nFINAL-SECTION-MARKER";
    const raw = `${REPORT}\n${"word ".repeat(800)}\nassistantfinal\n${ending}`;
    const cleaned = sanitizeReport(raw, { firstHeading: FIRST_HEADING });
    assert.match(cleaned, /FINAL-SECTION-MARKER/);
    assert.match(cleaned, /## 9\. Unclear Audio/);
  });

  it("cleanStoredText changes poisoned summaries and leaves clean ones", () => {
    const poisoned = `<reasoning>instructions</reasoning>\nHere is the report:\n${REPORT}`;
    const changed = cleanStoredText(poisoned, "report");
    assert.equal(changed.changed, true);
    assert.equal(changed.text.startsWith(FIRST_HEADING), true);
    const same = cleanStoredText(REPORT, "report");
    assert.equal(same.changed, false);
  });
});
