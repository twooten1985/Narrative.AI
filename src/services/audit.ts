import { format, isValid, parseISO } from "date-fns";

export const AI_DISCLAIMER = "AI-assisted summary. Verify against the original recording.";

export interface AuditFields {
  model?: string | null;
  requestId?: string | null;
  transcriptId?: string | null;
  generatedAt?: string | null;
  /** ISO time the user clicked I Acknowledge during the session that generated the report. */
  aiAcknowledgedAt?: string | null;
  /** Local-time sentence captured with the report. Re-export uses this, not a later session. */
  aiAcknowledgedLabel?: string | null;
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

export function formatAiAcknowledgement(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "AI use acknowledged by user (time not recorded).";
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeZoneName: "short",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  const when = `${part("month")} ${part("day")}, ${part("year")} ${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")}`
    .replace(/\s+/g, " ")
    .trim();
  return `AI use acknowledged by user on ${when}.`;
}

export function formatReportFooter(fields: AuditFields): string {
  return [AI_DISCLAIMER, fields.aiAcknowledgedLabel?.trim() || "", formatAuditLine(fields)].filter(Boolean).join("\n");
}
