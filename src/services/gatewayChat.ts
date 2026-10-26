import { DEFAULT_GATEWAY_MODEL, FALLBACK_GATEWAY_MODEL, REPORT_MAX_TOKENS, REPORT_TEMPERATURE } from "./config";
import type { ChatMessage, ChatResult } from "./reportPipeline";
import {
  GATEWAY_MAX_ATTEMPTS,
  GatewayError,
  chooseRetryDelayMs,
  classifyGatewayFailure,
  isRetryableGatewayKind,
  parseGatewayBody,
  parseRetryAfterSeconds,
} from "./gatewayErrors";

export interface RetryInfo {
  /** The attempt that is about to start (2 means the first retry). */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  kind: GatewayError["kind"];
  status: number | null;
  message: string;
  requestId: string | null;
  /** Epoch ms when the next attempt starts. */
  resumeAt: number;
}

export type GatewayProvider = "gateway" | "local";

export interface GatewayChatOptions {
  url: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
  provider?: GatewayProvider;
  /** Gateway-side model fallback. Off unless the user turned it on in Settings. */
  allowModelFallback?: boolean;
  maxAttempts?: number;
  signal?: AbortSignal;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onRetry?: (info: RetryInfo) => void;
  /** Receives one log line with no key and no transcript text. */
  log?: (line: string) => void;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function redactForLog(text: string, secret: string): string {
  let out = String(text || "").replace(/\s+/g, " ").slice(0, 300);
  if (secret) out = out.split(secret).join("[key]");
  return out;
}

function estimateRequestTokens(messages: ChatMessage[], maxTokens: number): number {
  const chars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  return Math.ceil(chars / 4) + maxTokens;
}

function isAbort(error: unknown): boolean {
  const e = error as { name?: string; code?: string };
  return e?.name === "AbortError" || e?.code === "ABORT_ERR";
}

export async function gatewayChat(opts: GatewayChatOptions): Promise<ChatResult & { attempts: number; requestIds: string[] }> {
  const fetchImpl = opts.fetchImpl || fetch;
  const provider: GatewayProvider = opts.provider || "gateway";
  const model = opts.model || DEFAULT_GATEWAY_MODEL;
  const maxTokens = opts.maxTokens ?? REPORT_MAX_TOKENS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? GATEWAY_MAX_ATTEMPTS);
  const sleep = opts.sleepImpl || abortableSleep;
  const log = opts.log || ((line: string) => console.error(line));
  const label = provider === "local" ? "local-llm" : "gateway";

  const payload: Record<string, unknown> = {
    model,
    messages: opts.messages,
    max_tokens: maxTokens,
    temperature: opts.temperature ?? REPORT_TEMPERATURE,
  };
  if (provider === "gateway" && opts.allowModelFallback === true) {
    const fallback = model === FALLBACK_GATEWAY_MODEL ? DEFAULT_GATEWAY_MODEL : FALLBACK_GATEWAY_MODEL;
    payload.fallbacks = [{ model: fallback }];
  }
  const body = JSON.stringify(payload);
  const estimate = estimateRequestTokens(opts.messages, maxTokens);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider === "gateway") headers.authorization = opts.apiKey;

  const requestIds: string[] = [];
  const cancelled = (attempt: number) =>
    new GatewayError({ status: null, kind: "cancelled", message: "Stopped by the user.", attempts: attempt, model, provider });

  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw cancelled(attempt);
    let response: Response | null = null;
    let failure: GatewayError | null = null;
    let headersForDelay: { get(name: string): string | null } | undefined;

    try {
      response = await fetchImpl(opts.url, { method: "POST", headers, body, signal: opts.signal });
    } catch (error: any) {
      if (isAbort(error) || opts.signal?.aborted) throw cancelled(attempt);
      const detail = redactForLog(error?.cause?.code || error?.code || error?.message || "network error", opts.apiKey);
      failure = new GatewayError({
        status: null,
        kind: "network",
        message: `Could not reach the ${provider === "local" ? "local model" : "LLM Gateway"} (${detail}).`,
        attempts: attempt,
        model,
        provider,
      });
    }

    if (response) {
      const rawText = await response.text().catch(() => "");
      let json: any = {};
      try { json = rawText ? JSON.parse(rawText) : {}; } catch { json = {}; }
      if (response.ok) {
        const requestId = json.request_id || null;
        if (requestId) requestIds.push(requestId);
        const choice = json.choices?.[0];
        const finish = choice?.finish_reason || choice?.stop_reason || json.stop_reason || null;
        log(`[${label}] ok model=${json.model || model} request_id=${requestId || "n/a"} finish=${finish || "n/a"} attempts=${attempt}`);
        return {
          content: choice?.message?.content,
          model: json.model || model,
          requestId,
          finishReason: finish,
          attempts: attempt,
          requestIds,
        };
      }
      const parsed = parseGatewayBody(json, rawText);
      const classified = classifyGatewayFailure({
        status: response.status,
        message: parsed.message,
        headers: response.headers,
        estimatedRequestTokens: estimate,
      });
      if (parsed.requestId) requestIds.push(parsed.requestId);
      const fallbackText = `${provider === "local" ? "Local model" : "LLM Gateway"} returned HTTP ${response.status} with no details.`;
      failure = new GatewayError({
        status: response.status,
        kind: classified.kind,
        message: parsed.message || fallbackText,
        requestId: parsed.requestId,
        retryAfter: parseRetryAfterSeconds(response.headers.get("retry-after")),
        attempts: attempt,
        model,
        provider,
        limits: classified.limits,
      });
      headersForDelay = response.headers;
    }

    failure!.requestIds = [...requestIds];
    const retryable = isRetryableGatewayKind(failure!.kind);
    log(
      `[${label}] status=${failure!.status ?? "none"} kind=${failure!.kind} request_id=${failure!.requestId || "n/a"} model=${model} ` +
      `attempt=${attempt}/${maxAttempts} message="${redactForLog(failure!.message, opts.apiKey)}"`
    );
    if (!retryable || attempt >= maxAttempts) throw failure;

    const wait = chooseRetryDelayMs({ failedAttempt: attempt, kind: failure!.kind, headers: headersForDelay, random: opts.random });
    if (wait.retryAfterSeconds !== null) failure!.retryAfter = wait.retryAfterSeconds;
    if (wait.tooLong) throw failure;
    opts.onRetry?.({
      attempt: attempt + 1,
      maxAttempts,
      delayMs: wait.delayMs,
      kind: failure!.kind,
      status: failure!.status,
      message: failure!.message,
      requestId: failure!.requestId,
      resumeAt: Date.now() + wait.delayMs,
    });
    try {
      await sleep(wait.delayMs, opts.signal);
    } catch (error) {
      if (isAbort(error) || opts.signal?.aborted) throw cancelled(attempt);
      throw error;
    }
  }
}
