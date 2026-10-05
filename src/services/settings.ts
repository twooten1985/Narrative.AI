import {
  DEFAULT_AAI_API_BASE,
  DEFAULT_CHUNK_TOKEN_LIMIT,
  DEFAULT_LLM_GATEWAY_URL,
  isHttpsOrLocalUrl,
} from "./config";
import { DEFAULT_MASS_CONCURRENCY, MAX_MASS_CONCURRENCY } from "./memoryLimits";

export interface AppSettings {
  allowGemini: boolean;
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
  return {
    allowGemini: src.allowGemini === true,
    deleteRemoteTranscripts: src.deleteRemoteTranscripts !== false,
    aaiApiBase: cleanUrl(src.aaiApiBase, DEFAULT_AAI_API_BASE),
    llmGatewayUrl: cleanUrl(src.llmGatewayUrl, DEFAULT_LLM_GATEWAY_URL).replace(/\/$/, "") || DEFAULT_LLM_GATEWAY_URL,
    officerName: typeof src.officerName === "string" ? src.officerName.trim().slice(0, 120) : "",
    officerBadge: typeof src.officerBadge === "string" ? src.officerBadge.trim().slice(0, 40) : "",
    chunkTokenLimit: Number.isFinite(limit) && limit >= 8_000 && limit <= 400_000
      ? Math.round(limit)
      : DEFAULT_CHUNK_TOKEN_LIMIT,
    massConcurrency: Number.isFinite(concurrency) && concurrency >= 1 && concurrency <= MAX_MASS_CONCURRENCY
      ? Math.round(concurrency)
      : DEFAULT_MASS_CONCURRENCY,
  };
}
