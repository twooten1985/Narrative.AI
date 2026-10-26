/**
 * Text for the "Copy diagnostics" button. It is for support, not for the case file.
 * It holds the app version, the model, the real service message and the request IDs.
 * It never holds an API key or any case content.
 */
import type { ReportErrorInfo } from "./reportClient";

export interface ServerDiagnostics {
  appVersion?: string;
  provider?: string;
  gatewayModel?: string;
  localModel?: string | null;
  chunkTokenLimit?: number;
  gatewayConcurrency?: number;
  allowModelFallback?: boolean;
  queue?: { running: number; waiting: number };
  recentEvents?: { at: string; engine: string; model: string; line: string }[];
}

export function providerWords(provider?: string | null): string {
  if (provider === "local") return "Local model on this PC";
  if (provider === "off") return "Summaries turned off";
  return "Cloud: AssemblyAI";
}

export function buildDiagnosticsText(opts: {
  appVersion: string;
  now?: Date;
  server?: ServerDiagnostics | null;
  info?: ReportErrorInfo | null;
  shownMessage?: string | null;
  partial?: { saved: number; total: number } | null;
}): string {
  const { info, server } = opts;
  const lines: string[] = [];
  lines.push("Narrative AI diagnostics");
  lines.push(`App version: ${opts.appVersion}`);
  lines.push(`Created: ${(opts.now || new Date()).toISOString()} (UTC)`);
  if (server?.provider) lines.push(`Summary setting: ${providerWords(server.provider)}`);
  if (info?.model || server?.gatewayModel) lines.push(`Model: ${info?.model || server?.gatewayModel}`);
  if (server?.localModel) lines.push(`Local model name: ${server.localModel}`);
  if (typeof server?.chunkTokenLimit === "number") lines.push(`Chunk size setting: ${server.chunkTokenLimit} tokens`);
  if (typeof server?.gatewayConcurrency === "number") lines.push(`Summary calls at once: ${server.gatewayConcurrency}`);
  if (typeof server?.allowModelFallback === "boolean") lines.push(`Gateway model fallback: ${server.allowModelFallback ? "on" : "off"}`);
  if (info) {
    lines.push("");
    lines.push("Last failure");
    lines.push(`Kind: ${info.kind}`);
    lines.push(`HTTP status: ${info.status ?? "none (no response)"}`);
    lines.push(`Attempts made: ${info.attempts}`);
    if (info.retryAfter) lines.push(`Service asked to wait: ${info.retryAfter} seconds`);
    lines.push(`Service message: ${info.realMessage || "none"}`);
    const ids = info.requestIds && info.requestIds.length ? info.requestIds : info.requestId ? [info.requestId] : [];
    lines.push(`Request IDs: ${ids.length ? ids.join(", ") : "none returned"}`);
    if (info.note) lines.push(`Where it was sent: ${info.note}`);
  } else if (opts.shownMessage) {
    lines.push("");
    lines.push(`Message shown: ${opts.shownMessage}`);
  }
  if (opts.partial) lines.push(`Finished parts saved: ${opts.partial.saved}`);
  if (server?.queue) lines.push(`Summary queue: ${server.queue.running} running, ${server.queue.waiting} waiting`);
  if (server?.recentEvents && server.recentEvents.length > 0) {
    lines.push("");
    lines.push("Recent summary-service events");
    for (const event of server.recentEvents) lines.push(`${event.at} ${event.line}`);
  }
  lines.push("");
  lines.push("This text contains no API keys and no case content.");
  return lines.join("\n");
}