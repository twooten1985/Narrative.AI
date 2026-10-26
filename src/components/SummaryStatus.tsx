import React, { useEffect, useState } from "react";
import { AlertCircle, Cloud, Copy, Download, HardDrive, Loader2, RotateCcw, Square } from "lucide-react";
import { apiFetch, authHeaders } from "../services/apiClient";
import { buildDiagnosticsText, providerWords } from "../services/diagnostics";
import { secondsUntil, type ReportErrorInfo, type RetryState } from "../services/reportClient";
import { APP_VERSION } from "../version";

export type SummaryProviderSetting = "gateway" | "local" | "off";

/** A small label that always says where the case text goes for the next summary. */
export function EngineBadge({ provider, className = "" }: { provider: SummaryProviderSetting; className?: string }) {
  const local = provider === "local";
  const off = provider === "off";
  const label = off ? "Summaries off" : local ? "Local: Ollama" : "Cloud: AssemblyAI";
  const tone = off
    ? "border-white/15 text-white/50"
    : local
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : "border-sky-500/40 bg-sky-500/10 text-sky-300";
  return (
    <span
      data-testid="engine-badge"
      title={off ? "No case text is sent anywhere." : local ? "Summaries stay on this PC." : "Summaries are written by AssemblyAI."}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tone} ${className}`}
    >
      {local ? <HardDrive size={11} /> : <Cloud size={11} />}
      {label}
    </span>
  );
}

/** "Rate limited, retrying in 20s (attempt 2 of 5)" with a Cancel button. */
export function RetryBanner({ retry, onCancel }: { retry: RetryState | null; onCancel?: () => void }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!retry) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 500);
    return () => window.clearInterval(timer);
  }, [retry?.resumeAt]);
  if (!retry) return null;
  const seconds = secondsUntil(retry.resumeAt);
  const what = retry.kind === "server" || retry.kind === "network" ? "Service busy" : "Rate limited";
  return (
    <div data-testid="retry-banner" className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <Loader2 size={14} className="animate-spin shrink-0" />
      <span>
        {what}, retrying in {seconds}s (attempt {retry.attempt} of {retry.maxAttempts})
      </span>
      {onCancel && (
        <button type="button" onClick={onCancel} className="ml-auto inline-flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold hover:bg-white/20">
          <Square size={11} /> Cancel
        </button>
      )}
    </div>
  );
}

async function downloadText(url: string, fallbackName: string) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error("The transcript could not be exported.");
  const blob = await res.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

/** Plain failure message, a Retry button that keeps finished parts, and a details drawer. */
export function SummaryErrorPanel({
  message,
  info,
  partial,
  provider,
  recordingId,
  exportUrl,
  exportName,
  busy,
  canUseLocal,
  canUseGemini,
  onRetry,
  onUseLocal,
  onUseGemini,
  transcriptSaved,
}: {
  message: string;
  info?: ReportErrorInfo | null;
  partial?: { saved: number; total: number } | null;
  provider: SummaryProviderSetting;
  recordingId?: string | null;
  /** Used when the transcript is not saved on a recording yet (Mass Processing). */
  exportUrl?: string | null;
  exportName?: string;
  busy?: boolean;
  canUseLocal?: boolean;
  canUseGemini?: boolean;
  onRetry?: () => void;
  onUseLocal?: () => void;
  onUseGemini?: () => void;
  /** The transcript is stored on this PC, so Retry never transcribes the audio again. */
  transcriptSaved?: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const ids = info?.requestIds && info.requestIds.length ? info.requestIds : info?.requestId ? [info.requestId] : [];
  const where = exportUrl || (recordingId ? `/api/recordings/${encodeURIComponent(recordingId)}/transcript.txt` : null);

  const copyDiagnostics = async () => {
    let server: any = null;
    try { server = await apiFetch("/api/diagnostics"); } catch { server = null; }
    const text = buildDiagnosticsText({ appVersion: APP_VERSION, server, info, shownMessage: message, partial });
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Diagnostics copied. They hold no keys and no case content.");
    } catch {
      setCopied("Could not copy. Select the details above and copy them by hand.");
    }
  };

  const exportTranscript = async () => {
    if (!where) return;
    setLocalError(null);
    try {
      await downloadText(where, `${(exportName || "transcript").replace(/\.[^.]+$/, "")}-transcript.txt`);
    } catch (error: any) {
      setLocalError(error?.message || "The transcript could not be exported.");
    }
  };

  return (
    <div data-testid="summary-error" className="space-y-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
      <div className="flex items-start gap-3">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
        <div className="space-y-1">
          <p>{message}</p>
          {transcriptSaved && (
        <p className="text-xs text-red-200/70" data-testid="transcript-saved">Transcript saved on this PC. Retry will not transcribe the audio again.</p>
      )}
      {partial && partial.saved > 0 && (
            <p className="text-xs text-red-200/70">{partial.saved} finished part{partial.saved === 1 ? "" : "s"} saved. Retry continues where it stopped.</p>
          )}
          {info?.note && <p className="text-xs text-red-200/70">{info.note}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onRetry && (
          <button type="button" disabled={busy} onClick={onRetry} className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50">
            <RotateCcw size={12} /> Retry
          </button>
        )}
        {canUseLocal && onUseLocal && (
          <button type="button" disabled={busy} onClick={onUseLocal} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold disabled:opacity-50" title="Writes this summary with the model on this PC. Nothing is sent to the cloud.">
            Use local model
          </button>
        )}
        {canUseGemini && onUseGemini && (
          <button type="button" disabled={busy} onClick={onUseGemini} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold disabled:opacity-50">
            Send to Gemini instead
          </button>
        )}
        {where && (
          <button type="button" onClick={exportTranscript} className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold">
            <Download size={12} /> Export transcript
          </button>
        )}
      </div>
      <details className="text-xs text-red-100/80">
        <summary className="cursor-pointer select-none text-red-100">Details for support</summary>
        <div className="mt-2 space-y-1 font-mono text-[11px] leading-relaxed">
          <p>Setting: {providerWords(provider)}</p>
          {info && (
            <>
              <p>Kind: {info.kind}{info.status ? ` (HTTP ${info.status})` : ""}</p>
              <p>Attempts: {info.attempts}</p>
              <p>Service message: {info.realMessage || "none"}</p>
              <p>Request ID{ids.length === 1 ? "" : "s"}: {ids.length ? ids.join(", ") : "none returned"}</p>
            </>
          )}
        </div>
        <button type="button" onClick={copyDiagnostics} className="mt-2 inline-flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-white">
          <Copy size={12} /> Copy diagnostics
        </button>
        {copied && <p className="mt-1 text-[11px]">{copied}</p>}
      </details>
      {localError && <p className="text-xs text-red-200">{localError}</p>}
    </div>
  );
}