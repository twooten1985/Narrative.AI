/**
 * Decides which engine may write a summary, and says in plain words where the case text goes.
 *
 * Rules (enforced by the server routes, not only by the screen):
 *  - There is never an automatic switch. A failed request is not re-sent to another service.
 *  - Provider "off": nothing is sent anywhere.
 *  - Provider "gateway": AssemblyAI only (Google Gemini stays behind its own switch).
 *  - Provider "local": a model on this PC only. A cloud request is refused.
 *  - "Use local model" is an explicit click. It may run the local model once even when the
 *    provider is "gateway", but never the other way around.
 */
import type { AppSettings, SummaryProvider } from "./settings";
import { isLoopbackUrl } from "./config";

export type SummaryEngine = "gateway" | "local" | "gemini";

export interface EngineDecisionInput {
  /** What the request asked for. Missing means "whatever the setting says". */
  requested?: string | null;
  settings: Pick<AppSettings, "summaryProvider" | "allowGemini" | "localLlmUrl" | "localLlmModel">;
  /** True only when a person clicked "Use local model" for this request. */
  explicitLocal?: boolean;
  strictlyAssembly?: boolean;
  hasAssemblyKey: boolean;
  hasGeminiKey: boolean;
}

export type EngineDecision =
  | { ok: true; engine: SummaryEngine }
  | { ok: false; status: number; code: string; error: string };

export function providerLabel(provider: SummaryProvider): string {
  return provider === "local" ? "Local model on this PC" : provider === "off" ? "Summaries off" : "AssemblyAI";
}

export function decideEngine(input: EngineDecisionInput): EngineDecision {
  const { settings } = input;
  const provider = settings.summaryProvider;
  const requested = input.requested === "gemini" || input.requested === "local" || input.requested === "gateway" ? input.requested : null;
  const engine: SummaryEngine = requested || (provider === "local" ? "local" : "gateway");

  if (provider === "off") {
    return {
      ok: false,
      status: 403,
      code: "SUMMARY_OFF",
      error: "Summaries are turned off in Settings. Nothing was sent anywhere.",
    };
  }
  if (engine === "gemini") {
    if (!settings.allowGemini || input.strictlyAssembly) {
      return {
        ok: false,
        status: 403,
        code: "GEMINI_DISABLED",
        error: "Google Gemini is turned off for case data. Nothing was sent to Google. Enable Gemini in Settings only if your policy allows it.",
      };
    }
    if (!input.hasGeminiKey) return { ok: false, status: 400, code: "NO_KEY", error: "Gemini API key is not configured." };
    return { ok: true, engine };
  }
  if (engine === "local") {
    if (provider !== "local" && input.explicitLocal !== true) {
      return {
        ok: false,
        status: 403,
        code: "LOCAL_NEEDS_CLICK",
        error: "The local model is only used when you choose it. Open Settings and choose Local, or press Use local model.",
      };
    }
    if (!isLoopbackUrl(settings.localLlmUrl)) {
      return {
        ok: false,
        status: 400,
        code: "LOCAL_URL_NOT_LOCAL",
        error: "The local model address must be on this PC (127.0.0.1 or localhost). Nothing was sent.",
      };
    }
    if (!settings.localLlmModel.trim()) {
      return { ok: false, status: 400, code: "LOCAL_NO_MODEL", error: "Choose the local model name in Settings first (for example llama3.1)." };
    }
    return { ok: true, engine };
  }
  // engine === "gateway"
  if (provider === "local") {
    return {
      ok: false,
      status: 403,
      code: "CLOUD_BLOCKED_LOCAL_ONLY",
      error: "Summaries are set to the local model, so nothing was sent to AssemblyAI. Change the setting if you want the cloud service.",
    };
  }
  if (!input.hasAssemblyKey) return { ok: false, status: 400, code: "NO_KEY", error: "AssemblyAI API key is not configured." };
  return { ok: true, engine };
}

/** Where case text goes for an engine, in plain words. Used on screens and in errors. */
export function destinationName(engine: SummaryEngine | "assemblyai-gateway"): string {
  if (engine === "local") return "the local model on this PC";
  if (engine === "gemini") return "Google Gemini";
  return "AssemblyAI";
}

/**
 * The note added to an error message. Google is only named when Gemini was involved.
 * Everything else names the real destination, or says nothing left this PC.
 */
export function destinationNote(engine: SummaryEngine | "assemblyai-gateway" | null | undefined, opts: { geminiBlocked?: boolean } = {}): string {
  if (opts.geminiBlocked) return "Google Gemini is turned off for case data, so nothing was sent to Google.";
  if (engine === "gemini") return "This request went to Google Gemini.";
  if (engine === "local") return "This request stayed on this PC (local model).";
  if (engine === "gateway" || engine === "assemblyai-gateway") return "This request went to AssemblyAI. Nothing was sent to Google.";
  return "";
}

export function engineBadge(engine: SummaryEngine | "assemblyai-gateway" | "off"): string {
  if (engine === "local") return "Local: Ollama";
  if (engine === "gemini") return "Cloud: Google Gemini";
  if (engine === "off") return "Summaries off";
  return "Cloud: AssemblyAI";
}