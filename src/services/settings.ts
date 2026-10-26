import {
  DEFAULT_AAI_API_BASE,
  DEFAULT_CHUNK_TOKEN_LIMIT,
  DEFAULT_LLM_GATEWAY_URL,
  DEFAULT_LOCAL_CHUNK_TOKEN_LIMIT,
  DEFAULT_LOCAL_LLM_URL,
  LEGACY_CHUNK_TOKEN_LIMIT,
  isHttpsOrLocalUrl,
  isLoopbackUrl,
} from "./config";
import { DEFAULT_MASS_CONCURRENCY, MAX_MASS_CONCURRENCY } from "./memoryLimits";

export type SummaryProvider = "gateway" | "local" | "off";

export interface AppSettings {
  allowGemini: boolean;
  /** Where summaries are written. "gateway" is AssemblyAI. "local" is an OpenAI-compatible server on this PC. */
  summaryProvider: SummaryProvider;
  localLlmUrl: string;
  localLlmModel: string;
  localChunkTokenLimit: number;
  /** How many summary-model calls may run at once across the whole app (1 or 2). */
  gatewayConcurrency: number;
  /** Lets the AssemblyAI gateway switch to a second model by itself. Off by default. */
  allowModelFallback: boolean;
  deleteRemoteTranscripts: boolean;
  aaiApiBase: string;
  llmGatewayUrl: string;
  officerName: string;
  officerBadge: string;
  chunkTokenLimit: number;
  massConcurrency: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  allowGemini: false,
  summaryProvider: "gateway",
  localLlmUrl: DEFAULT_LOCAL_LLM_URL,
  localLlmModel: "",
  localChunkTokenLimit: DEFAULT_LOCAL_CHUNK_TOKEN_LIMIT,
  gatewayConcurrency: 1,
  allowModelFallback: false,
  deleteRemoteTranscripts: true,
  aaiApiBase: DEFAULT_AAI_API_BASE,
  llmGatewayUrl: DEFAULT_LLM_GATEWAY_URL,
  officerName: "",
  officerBadge: "",
  chunkTokenLimit: DEFAULT_CHUNK_TOKEN_LIMIT,
  massConcurrency: DEFAULT_MASS_CONCURRENCY,
};

function cleanUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\/$/, "");
  return isHttpsOrLocalUrl(trimmed) ? trimmed : fallback;
}

export function normalizeAppSettings(input: Partial<AppSettings> | null | undefined): AppSettings {
  const src = input || {};
  const limit = Number(src.chunkTokenLimit);
  const concurrency = Number(src.massConcurrency);
  const localLimit = Number(src.localChunkTokenLimit);
  const gwConcurrency = Number(src.gatewayConcurrency);
  const provider: SummaryProvider = src.summaryProvider === "local" || src.summaryProvider === "off" ? src.summaryProvider : "gateway";
  const localUrl = typeof src.localLlmUrl === "string" ? src.localLlmUrl.trim().replace(/\/$/, "") : "";
  return {
    allowGemini: src.allowGemini === true,
    summaryProvider: provider,
    // The local provider must stay on this PC. Anything else falls back to the Ollama default.
    localLlmUrl: localUrl && isLoopbackUrl(localUrl) ? localUrl : DEFAULT_LOCAL_LLM_URL,
    localLlmModel: typeof src.localLlmModel === "string" && /^[a-zA-Z0-9._:\/-]{0,100}$/.test(src.localLlmModel.trim()) ? src.localLlmModel.trim() : "",
    localChunkTokenLimit: Number.isFinite(localLimit) && localLimit >= 1_000 && localLimit <= 100_000 ? Math.round(localLimit) : DEFAULT_LOCAL_CHUNK_TOKEN_LIMIT,
    gatewayConcurrency: gwConcurrency === 2 ? 2 : 1,
    allowModelFallback: src.allowModelFallback === true,
    deleteRemoteTranscripts: src.deleteRemoteTranscripts !== false,
    aaiApiBase: cleanUrl(src.aaiApiBase, DEFAULT_AAI_API_BASE),
    llmGatewayUrl: cleanUrl(src.llmGatewayUrl, DEFAULT_LLM_GATEWAY_URL).replace(/\/$/, "") || DEFAULT_LLM_GATEWAY_URL,
    officerName: typeof src.officerName === "string" ? src.officerName.trim().slice(0, 120) : "",
    officerBadge: typeof src.officerBadge === "string" ? src.officerBadge.trim().slice(0, 40) : "",
    chunkTokenLimit: Number.isFinite(limit) && limit >= 8_000 && limit <= 400_000 && limit !== LEGACY_CHUNK_TOKEN_LIMIT
      ? Math.round(limit)
      : DEFAULT_CHUNK_TOKEN_LIMIT,
    massConcurrency: Number.isFinite(concurrency) && concurrency >= 1 && concurrency <= MAX_MASS_CONCURRENCY
      ? Math.round(concurrency)
      : DEFAULT_MASS_CONCURRENCY,
  };
}

