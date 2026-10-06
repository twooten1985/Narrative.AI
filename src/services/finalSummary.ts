import { AI_DISCLAIMER } from "./audit";

export const FINAL_SUMMARY_HEADING = "## Final Summary";

export const FINAL_SUMMARY_SECTION = `## Final Summary
<Concise narrative paragraphs an officer can paste into a police report. This is not a transcript. Cover who was present, what was discussed, when and where events were said to have occurred, admissions and denials, short quotes that matter with the speaker's name, the order of events described, inconsistencies in this recording, and how the interview ended. Use a mapped or grounded name instead of a speaker letter. If no name is known, keep the speaker label. Do not invent a name.>`;

/** Body under one Markdown heading, stopping at the next heading. */
export function extractSection(markdown: string | null | undefined, heading: string): string | null {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const wanted = heading.trim().toLowerCase();
  const start = lines.findIndex((line) => line.trim().toLowerCase() === wanted);
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const text = body.join("\n").trim();
  return text || null;
}

export function extractFinalSummary(markdown: string | null | undefined): string | null {
  return extractSection(markdown, FINAL_SUMMARY_HEADING);
}

/** Plain text for Word or an RMS field. Markdown markers and HTML tags are removed. */
export function markdownToPlain(markdown: string | null | undefined): string {
  let text = String(markdown || "").replace(/\r\n/g, "\n");
  text = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]*\)/g, "$1");
  text = text.replace(/<\/?[^>\n]+>/g, "");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/(\*\*|__)([\s\S]*?)\1/g, "$2");
  text = text.replace(/(\*|_)([^*\n_]+)\1/g, "$2");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function finalSummaryClipboard(
  markdown: string | null | undefined,
  acknowledgement?: string | null,
): string {
  const section = extractFinalSummary(markdown);
  if (!section) return "";
  const body = markdownToPlain(section);
  if (!body) return "";
  const footer = [AI_DISCLAIMER, acknowledgement?.trim() || ""].filter(Boolean).join("\n");
  return `${body}\n\n${footer}`.trim();
}
