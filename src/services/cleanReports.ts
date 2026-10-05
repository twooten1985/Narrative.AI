import { BASE_SYSTEM_PROMPT, FIRST_HEADING, TIMELINE_FIRST_HEADING, TIMELINE_SYSTEM_PROMPT } from "./reportPrompts";
import { sanitizeReport } from "./sanitizeReport";

export function cleanStoredText(text: string | null | undefined, kind: "report" | "timeline"): { text: string; changed: boolean } {
  const original = text ?? "";
  if (!original.trim()) return { text: original, changed: false };
  const first = kind === "timeline" ? TIMELINE_FIRST_HEADING : FIRST_HEADING;
  const instructionText = kind === "timeline" ? TIMELINE_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
  const cleaned = sanitizeReport(original, {
    // Only anchor on the heading when this report already uses it, so older
    // layouts are not cut apart just because the heading text is absent.
    firstHeading: original.includes(first) ? first : undefined,
    instructionText,
  });
  return { text: cleaned, changed: cleaned !== original };
}
