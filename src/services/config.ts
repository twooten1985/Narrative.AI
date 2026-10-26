// US endpoints are the default. EU residency is opt-in by changing the URL in Settings.
export const DEFAULT_AAI_API_BASE = "https://api.assemblyai.com";
export const DEFAULT_LLM_GATEWAY_URL = "https://llm-gateway.assemblyai.com/v1/chat/completions";
export const DEFAULT_GATEWAY_MODEL = "claude-sonnet-4-6";
export const FALLBACK_GATEWAY_MODEL = "gpt-oss-120b";

// Pre-recorded speech models already used by this app. Do not send word_boost with these:
// word_boost silently routes universal-3-5-pro down to universal-2. Use keyterms_prompt.
export const DEFAULT_SPEECH_MODELS = ["universal-3-5-pro", "universal-2"] as const;

// 6.1.6: smaller requests stay under per-minute token limits (the gateway reserves prompt + max_tokens).
export const DEFAULT_CHUNK_TOKEN_LIMIT = 50_000;
/** Before 6.1.6 the saved default was 100,000. A saved value of exactly that is treated as "never changed". */
export const LEGACY_CHUNK_TOKEN_LIMIT = 100_000;
export const TARGET_CHUNK_MS = 25 * 60 * 1000;
/** Share of the chunk limit that one block may use. */
export const CHUNK_CAP_RATIO = 0.8;
export const PER_CHUNK_TOKEN_CAP = Math.round(DEFAULT_CHUNK_TOKEN_LIMIT * CHUNK_CAP_RATIO);
export const MIN_CHUNK_TOKEN_LIMIT = 2_000;

export const DEFAULT_LOCAL_LLM_URL = "http://127.0.0.1:11434/v1";
/** Ollama answers with a small context window unless it is raised, so local summaries use small pieces. */
export const DEFAULT_LOCAL_CHUNK_TOKEN_LIMIT = 6_000;

export { JSON_BODY_LIMIT } from "./memoryLimits";

export const REPORT_MAX_TOKENS = 16000;
export const REPORT_TEMPERATURE = 0.1;

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  } catch {
    return false;
  }
}

export function isHttpsOrLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return true;
    return false;
  } catch {
    return false;
  }
}

export function normalizeModelId(model: string | null | undefined): string {
  const value = (model || "").trim();
  if (/^[a-zA-Z0-9._:-]{1,80}$/.test(value)) return value;
  return DEFAULT_GATEWAY_MODEL;
}
