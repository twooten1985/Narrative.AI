// Backstop that removes reasoning traces, echoed prompt text and chatty preambles
// from LLM output before it is saved to the DB / shown / exported.
// Safe to run on any model's output (Gateway gpt-oss / Claude / Gemini).

const norm = (s: string) =>
  s.toLowerCase().replace(/[*_#`>"'“”‘’\-–—:;,.()\[\]<>]/g, " ").replace(/\s+/g, " ").trim();

const REASONING_TAGS = "reasoning|think|thinking|analysis|scratchpad";

export interface SanitizeOptions {
  /** Expected first heading, e.g. "## 1. Case Information". Anything before it is dropped. */
  firstHeading?: string;
  /** Full instruction text that was sent; lines copied verbatim from it are dropped. */
  instructionText?: string;
}

export function sanitizeReport(raw: string | null | undefined, opts: SanitizeOptions = {}): string {
  if (!raw) return "";
  let t = String(raw).replace(/\r\n/g, "\n");

  // 1) Closed reasoning blocks, e.g. <reasoning>The user wants ...</reasoning> (gpt-oss via Bedrock)
  t = t.replace(new RegExp(`<(${REASONING_TAGS})>[\\s\\S]*?<\\/\\1>`, "gi"), "");

  // 2) Unclosed reasoning block at the start: drop up to the first Markdown heading
  if (new RegExp(`^\\s*<(${REASONING_TAGS})>`, "i").test(t)) {
    const h = t.search(/^#{1,3}\s/m);
    t = h >= 0 ? t.slice(h) : t.replace(new RegExp(`^\\s*<(${REASONING_TAGS})>`, "i"), "");
  }

  // 3) Harmony-format leftovers from gpt-oss ("<|channel|>final<|message|>", "analysis...assistantfinal")
  const finalIdx = t.search(/<\|channel\|>\s*final\s*<\|message\|>/);
  if (finalIdx >= 0 && finalIdx < 4000) t = t.slice(finalIdx).replace(/^<\|channel\|>\s*final\s*<\|message\|>/, "");
  const af = t.search(/assistantfinal/i);
  // Only a preamble. A match later in a long report is case text and must stay.
  if (af >= 0 && af < 2000) t = t.slice(af + "assistantfinal".length);
  t = t.replace(/<\|[a-z_]+\|>/gi, "");

  // 4) Whole answer wrapped in a code fence
  const fenced = t.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) t = fenced[1];

  // 5) Everything before the expected first heading (restated prompt, "Here is the report:", etc.)
  if (opts.firstHeading) {
    const i = t.indexOf(opts.firstHeading);
    if (i > 0) t = t.slice(i);
    else if (i < 0) {
      // Heading text present without the exact numbering/markup: cut at the first heading line instead.
      const h = t.search(/^#{1,3}\s/m);
      if (h > 0) t = t.slice(h);
    }
  } else {
    const h = t.search(/^#{1,3}\s/m);
    if (h > 0 && h < 1500) t = t.slice(h);
  }

  // 6) Lines copied from the instructions (8+ words found verbatim in the prompt)
  if (opts.instructionText) {
    const promptNorm = norm(opts.instructionText);
    t = t
      .split("\n")
      .filter((line) => {
        const n = norm(line);
        if (n.split(" ").length < 8) return true;
        return !promptNorm.includes(n);
      })
      .join("\n");
  }

  // 7) Leading labels / preambles and trailing chatter
  t = t.replace(/^\s*(prompt|instructions?|task|system( instruction)?|user|assistant|response|answer|report|output)\s*:\s*\n/i, "");
  t = t.replace(/^\s*(sure|certainly|okay|ok|of course)[!,.]?[^\n]*\n+/i, "");
  t = t.replace(/^\s*(here is|here's|below is|the following is)[^\n]*:\s*\n+/i, "");
  t = t.replace(/\n+\s*(let me know|i hope this|if you (need|would like|want)|feel free to)[^\n]*\s*$/i, "");

  return t.replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip reasoning from a continuation. Do not drop text that comes before a later heading. */
export function sanitizeContinuation(raw: string | null | undefined): string {
  if (!raw) return "";
  let t = String(raw).replace(/\r\n/g, "\n");
  t = t.replace(new RegExp(`<(${REASONING_TAGS})>[\\s\\S]*?<\\/\\1>`, "gi"), "");
  if (new RegExp(`^\\s*<(${REASONING_TAGS})>`, "i").test(t)) {
    const h = t.search(/^#{1,3}\s/m);
    t = h >= 0 ? t.slice(h) : t.replace(new RegExp(`^\\s*<(${REASONING_TAGS})>`, "i"), "");
  }
  const finalIdx = t.search(/<\|channel\|>\s*final\s*<\|message\|>/);
  if (finalIdx >= 0 && finalIdx < 4000) t = t.slice(finalIdx).replace(/^<\|channel\|>\s*final\s*<\|message\|>/, "");
  const af = t.search(/assistantfinal/i);
  if (af >= 0 && af < 2000) t = t.slice(af + "assistantfinal".length);
  t = t.replace(/<\|[a-z_]+\|>/gi, "");
  t = t.replace(/^\s*(continuing|continuation|here is the rest|the rest of the report)\s*:\s*\n+/i, "");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}
