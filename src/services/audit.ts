import { format, isValid, parseISO } from "date-fns";

export const AI_DISCLAIMER = "AI-assisted summary. Verify against the original recording.";

export interface AuditFields {
  model?: string | null;
  requestId?: string | null;
  transcriptId?: string | null;
  generatedAt?: string | null;
}

export function formatGeneratedAt(value?: string | null): string {
  if (!value) return "Unknown";
  const parsed = parseISO(value);
  const date = isValid(parsed) ? parsed : new Date(value);
  if (!isValid(date)) return value;
  return format(date, "yyyy-MM-dd HH:mm:ss");
}

export function formatAuditLine(fields: AuditFields): string {
  return [
    `Model: ${fields.model || "Unknown"}`,
    `Request ID: ${fields.requestId || "Unknown"}`,
    `Transcript ID: ${fields.transcriptId || "Unknown"}`,
    `Generated: ${formatGeneratedAt(fields.generatedAt)}`,
  ].join(" | ");
}

export function formatReportFooter(fields: AuditFields): string {
  return `${AI_DISCLAIMER}\n${formatAuditLine(fields)}`;
}
