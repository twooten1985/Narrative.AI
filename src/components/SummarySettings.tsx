import React, { useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { apiFetch } from "../services/apiClient";
import { EngineBadge, type SummaryProviderSetting } from "./SummaryStatus";

interface CheckLine { ok: boolean; message: string }
interface TestResult { provider: string; key: CheckLine; transcription: CheckLine; summary: CheckLine; summaryModel: string }

const FIELD = "w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-500";
const LABEL = "text-[10px] font-bold uppercase tracking-widest text-white/40 px-1";

function Line({ title, line }: { title: string; line: CheckLine }) {
  return (
    <div className="flex items-start gap-2 text-[12px]">
      {line.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-400" /> : <XCircle size={14} className="mt-0.5 shrink-0 text-red-400" />}
      <p><span className="font-bold">{title}: </span><span className="text-white/75">{line.message}</span></p>
    </div>
  );
}

/** Settings block: where summaries are written, and a three-part connection test. */
export function SummarySettings({
  provider,
  onProvider,
  localUrl,
  onLocalUrl,
  localModel,
  onLocalModel,
  localChunk,
  onLocalChunk,
  concurrency,
  onConcurrency,
  allowFallback,
  onAllowFallback,
  model,
}: {
  provider: SummaryProviderSetting;
  onProvider: (value: SummaryProviderSetting) => void;
  localUrl: string;
  onLocalUrl: (value: string) => void;
  localModel: string;
  onLocalModel: (value: string) => void;
  localChunk: string;
  onLocalChunk: (value: string) => void;
  concurrency: string;
  onConcurrency: (value: string) => void;
  allowFallback: boolean;
  onAllowFallback: (value: boolean) => void;
  model: string;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    setTestError(null);
    try {
      const data = await apiFetch("/api/summary/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summaryProvider: provider, localLlmUrl: localUrl, localLlmModel: localModel, model }),
      });
      setResult(data);
    } catch (error: any) {
      setTestError(error?.message || "The test could not run.");
    } finally {
      setTesting(false);
    }
  };

  const choice = (value: SummaryProviderSetting, title: string, help: string) => (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${provider === value ? "border-orange-500/60 bg-orange-500/5" : "border-white/10"}`}>
      <input type="radio" name="summary-provider" checked={provider === value} onChange={() => onProvider(value)} className="mt-1" />
      <span>
        <span className="block text-sm font-bold">{title}</span>
        <span className="block text-[11px] text-white/50">{help}</span>
      </span>
    </label>
  );

  return (
    <div className="space-y-3 rounded-xl border border-white/10 p-4" data-testid="summary-settings">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold">Where summaries are written</p>
        <EngineBadge provider={provider} />
      </div>
      <p className="text-[10px] text-white/40">
        The app never switches between these by itself. If a summary fails, nothing is re-sent somewhere else unless you press a button.
        Transcription still uses AssemblyAI unless Local Whisper is turned on.
      </p>
      <div className="grid gap-2">
        {choice("gateway", "AssemblyAI (cloud)", "Uses your AssemblyAI key and the LLM Gateway.")}
        {choice("local", "Local model on this PC", "An OpenAI-compatible server such as Ollama. Case text never leaves this PC.")}
        {choice("off", "Off", "No summaries. Transcripts only.")}
      </div>

      {provider === "local" && (
        <div className="space-y-2">
          <div className="space-y-1">
            <label className={LABEL}>Local server address</label>
            <input value={localUrl} onChange={(e) => onLocalUrl(e.target.value)} className={FIELD} placeholder="http://127.0.0.1:11434/v1" />
            <p className="px-1 text-[10px] text-white/30">Must be on this PC (127.0.0.1 or localhost). Ollama default: http://127.0.0.1:11434/v1</p>
          </div>
          <div className="space-y-1">
            <label className={LABEL}>Local model name</label>
            <input value={localModel} onChange={(e) => onLocalModel(e.target.value)} className={FIELD} placeholder="llama3.1" />
          </div>
          <div className="space-y-1">
            <label className={LABEL}>Split transcripts over this many tokens (local)</label>
            <input value={localChunk} onChange={(e) => onLocalChunk(e.target.value)} className={FIELD} />
            <p className="px-1 text-[10px] text-white/30">Small local models have small memory windows. 6000 is a safe start.</p>
          </div>
        </div>
      )}
      {provider !== "local" && (
        <button type="button" onClick={() => onProvider("local")} className="rounded-lg bg-white/10 px-3 py-2 text-xs font-bold">
          Use local model
        </button>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className={LABEL}>Summary calls at once</label>
          <select value={concurrency === "2" ? "2" : "1"} onChange={(e) => onConcurrency(e.target.value)} className={FIELD}>
            <option value="1">1 (safest)</option>
            <option value="2">2</option>
          </select>
          <p className="px-1 text-[10px] text-white/30">Shared by every report and Mass Processing run.</p>
        </div>
        <label className="flex items-start gap-2 pt-5 text-[11px] text-white/60">
          <input type="checkbox" checked={allowFallback} onChange={(e) => onAllowFallback(e.target.checked)} className="mt-0.5" />
          Let the AssemblyAI gateway switch to a second model by itself (off by default)
        </label>
      </div>

      <div className="space-y-2 border-t border-white/10 pt-3">
        <button type="button" onClick={runTest} disabled={testing} className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-xs font-bold disabled:opacity-50">
          {testing && <Loader2 size={12} className="animate-spin" />} Test connection
        </button>
        <p className="text-[10px] text-white/40">Checks the key, transcription and the summary model one by one. Only a short made-up test message is sent. If you just typed a new key, press Save first.</p>
        {testError && <p className="text-[11px] text-red-300">{testError}</p>}
        {result && (
          <div className="space-y-1.5" data-testid="connection-results">
            <Line title="Key" line={result.key} />
            <Line title="Transcription" line={result.transcription} />
            <Line title={result.summaryModel ? `Summary (${result.summaryModel})` : "Summary"} line={result.summary} />
          </div>
        )}
      </div>
    </div>
  );
}