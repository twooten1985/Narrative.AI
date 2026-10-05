export interface InlineSpan {
  text: string;
  bold?: boolean;
  italics?: boolean;
}

export interface MarkdownBlock {
  type: "heading" | "bullet" | "numbered" | "paragraph" | "blank";
  level: number;
  text: string;
}

/** Split a markdown line into bold / italic spans. Markers are not left in the text. */
export function parseInlineSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const re = /(\*\*\*[^*]+?\*\*\*|\*\*[^*]+?\*\*|\*[^*]+?\*|_[^_]+?_)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index) });
    const token = match[1];
    if (token.startsWith("***")) spans.push({ text: token.slice(3, -3), bold: true, italics: true });
    else if (token.startsWith("**")) spans.push({ text: token.slice(2, -2), bold: true });
    else spans.push({ text: token.slice(1, -1), italics: true });
    last = match.index + token.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  if (spans.length === 0) spans.push({ text });
  return spans;
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = (markdown || "").replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (!line.trim()) {
      blocks.push({ type: "blank", level: 0, text: "" });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    const level = Math.min(2, Math.floor(indent / 2));
    const trimmed = line.trim();
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      blocks.push({ type: "numbered", level, text: numbered[2] });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      blocks.push({ type: "bullet", level, text: bullet[1] });
      continue;
    }
    blocks.push({ type: "paragraph", level: 0, text: trimmed });
  }
  return blocks;
}
