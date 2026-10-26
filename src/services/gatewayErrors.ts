export type GatewayErrorKind =
  | "rate_limit_rpm"
  | "rate_limit_tpm"
  | "server"
  | "size"
  | "auth"
  | "network"
  | "client"
  | "cancelled";

export const GATEWAY_MAX_ATTEMPTS = 5;
export const BACKOFF_CAP_MS = 60_000;
/** A server-supplied wait longer than this is not waited out automatically. */
export const MAX_HONORED_WAIT_MS = 120_000;

export interface GatewayErrorInit {
  status: number | null;
  kind: GatewayErrorKind;
  message: string;
  requestId?: string | null;
  retryAfter?: number | null;
  attempts?: number;
  model?: string | null;
  provider?: string | null;
  limits?: { limitTokens?: number | null; requestedTokens?: number | null } | null;
}

/** Typed failure from the summary model call. `message` is the real message from the service. */
export class GatewayError extends Error {
  status: number | null;
  kind: GatewayErrorKind;
  requestId: string | null;
  retryAfter: number | null;
  attempts: number;
  model: string | null;
  provider: string | null;
  limits: { limitTokens?: number | null; requestedTokens?: number | null } | null;
  /** Request IDs from every attempt, oldest first. */
  requestIds: string[] = [];

  constructor(init: GatewayErrorInit) {
    super(init.message);
    this.name = "GatewayError";
    this.status = init.status;
    this.kind = init.kind;
    this.requestId = init.requestId ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.attempts = init.attempts ?? 1;
    this.model = init.model ?? null;
    this.provider = init.provider ?? null;
    this.limits = init.limits ?? null;
  }
}

export function isGatewayError(error: unknown): error is GatewayError {
  return error instanceof GatewayError || (Boolean(error) && (error as any)?.name === "GatewayError");
}

export interface ParsedGatewayBody {
  message: string;
  code: number | null;
  requestId: string | null;
  details: string[];
}

/** Handles the flat {request_id, message, code} body, OpenAI-style {error:{message}}, a string error, and plain text. */
export function parseGatewayBody(result: any, rawText = ""): ParsedGatewayBody {
  const body = result && typeof result === "object" ? result : {};
  let message = "";
  if (typeof body.error === "string") message = body.error;
  else if (typeof body.error?.message === "string") message = body.error.message;
  else if (typeof body.message === "string") message = body.message;
  if (!message && rawText && !rawText.trim().startsWith("{")) message = rawText.trim();
  const requestId =
    (typeof body.request_id === "string" && body.request_id) ||
    (typeof body.error?.request_id === "string" && body.error.request_id) ||
    null;
  const rawCode = body.code ?? body.error?.code;
  const code = typeof rawCode === "number" ? rawCode : Number.isFinite(Number(rawCode)) && rawCode !== undefined && rawCode !== null && rawCode !== "" ? Number(rawCode) : null;
  const details: string[] = Array.isArray(body.metadata?.errors) ? body.metadata.errors.filter((e: unknown) => typeof e === "string").slice(0, 5) : [];
  return { message: message.trim(), code, requestId, details };
}

const SIZE_PATTERNS = [
  /request too large/i,
  /too large for (this|your)/i,
  /payload too large/i,
  /context (length|window)/i,
  /maximum context/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many (input )?tokens in (the )?(request|prompt)/i,
  /exceeds? (the )?(maximum|max|model|context|limit)/i,
  /(max_tokens|max tokens).*(too large|exceed|greater than)/i,
];

function headerNumber(headers: Headers | { get(name: string): string | null } | undefined, name: string): number | null {
  const raw = headers?.get?.(name);
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** "Limit 30000, Requested 45000" style messages that say a single request can never fit. */
export function parseRequestedVersusLimit(message: string): { limitTokens: number; requestedTokens: number } | null {
  const limit = /limit[:\s]+(\d[\d,]*)/i.exec(message);
  const requested = /requested[:\s]+(\d[\d,]*)/i.exec(message);
  if (!limit || !requested) return null;
  const limitTokens = Number(limit[1].replace(/,/g, ""));
  const requestedTokens = Number(requested[1].replace(/,/g, ""));
  if (!Number.isFinite(limitTokens) || !Number.isFinite(requestedTokens)) return null;
  return { limitTokens, requestedTokens };
}

export function classifyGatewayFailure(opts: {
  status: number;
  message: string;
  headers?: Headers | { get(name: string): string | null };
  estimatedRequestTokens?: number;
}): { kind: GatewayErrorKind; limits: { limitTokens: number | null; requestedTokens: number | null } | null } {
  const { status, message } = opts;
  const text = message || "";
  const tpmOnly = /tokens per minute/i.test(text) || /\bTPM\b/.test(text);
  const pair = parseRequestedVersusLimit(text);
  const limitHeader = headerNumber(opts.headers, "x-ratelimit-limit-tokens");
  const estimate = opts.estimatedRequestTokens ?? null;

  if (status === 401 || status === 403) return { kind: "auth", limits: null };
  if (status === 413) return { kind: "size", limits: pair };
  if (status === 429) {
    if (pair && pair.requestedTokens > pair.limitTokens) return { kind: "size", limits: pair };
    if (tpmOnly || /tokens/i.test(text)) {
      if (limitHeader !== null && estimate !== null && estimate > limitHeader) {
        return { kind: "size", limits: { limitTokens: limitHeader, requestedTokens: estimate } };
      }
      return { kind: "rate_limit_tpm", limits: limitHeader !== null ? { limitTokens: limitHeader, requestedTokens: estimate } : null };
    }
    if (SIZE_PATTERNS.some((p) => p.test(text)) && /too large/i.test(text)) return { kind: "size", limits: pair };
    return { kind: "rate_limit_rpm", limits: null };
  }
  if (status === 400 && SIZE_PATTERNS.some((p) => p.test(text))) return { kind: "size", limits: pair };
  if (status >= 500) return { kind: "server", limits: null };
  return { kind: "client", limits: null };
}

export function isRetryableGatewayKind(kind: GatewayErrorKind): boolean {
  return kind === "rate_limit_rpm" || kind === "rate_limit_tpm" || kind === "server" || kind === "network";
}

/** Retry-After as seconds, from either delta-seconds or an HTTP date. */
export function parseRetryAfterSeconds(raw: string | null | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Number(trimmed));
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

export function backoffDelayMs(failedAttempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_CAP_MS, 2000 * 2 ** Math.max(0, failedAttempt - 1));
  const jittered = base * (0.5 + random() * 0.5);
  return Math.min(BACKOFF_CAP_MS, Math.round(jittered));
}

/** Wait chosen for the next attempt. Server hints win; jitter only adds up to 1 s. */
export function chooseRetryDelayMs(opts: {
  failedAttempt: number;
  kind: GatewayErrorKind;
  headers?: Headers | { get(name: string): string | null };
  random?: () => number;
  now?: number;
}): { delayMs: number; fromServer: boolean; retryAfterSeconds: number | null; tooLong: boolean } {
  const random = opts.random || Math.random;
  const retryAfter = parseRetryAfterSeconds(opts.headers?.get?.("retry-after"), opts.now);
  const reset = headerNumber(opts.headers, "x-ratelimit-reset");
  const resetTokens = headerNumber(opts.headers, "x-ratelimit-reset-tokens");
  const hints = [retryAfter, opts.kind === "rate_limit_tpm" ? resetTokens : reset, opts.kind === "rate_limit_rpm" ? reset : null]
    .filter((v): v is number => typeof v === "number" && v >= 0);
  if (hints.length > 0) {
    const seconds = Math.max(...hints);
    const ms = Math.round(seconds * 1000 + random() * 1000);
    return { delayMs: ms, fromServer: true, retryAfterSeconds: Math.ceil(seconds), tooLong: ms > MAX_HONORED_WAIT_MS };
  }
  return { delayMs: backoffDelayMs(opts.failedAttempt, random), fromServer: false, retryAfterSeconds: null, tooLong: false };
}

/** Plain words for a person. No request IDs and no raw JSON. */
export function describeGatewayError(error: GatewayError, destination = "AssemblyAI"): string {
  const wait = error.retryAfter ? ` Wait about ${error.retryAfter} seconds before trying again.` : "";
  switch (error.kind) {
    case "rate_limit_rpm":
      return `${destination} is limiting how many requests this account can send per minute.${wait} Your transcript and any finished parts are saved. Press Retry in a minute.`;
    case "rate_limit_tpm":
      return `${destination} is limiting how much text this account can send per minute.${wait} Your transcript and any finished parts are saved. Press Retry in a minute.`;
    case "size":
      return `That piece of the transcript was too large for the ${destination} account limit, even after shrinking it. Your transcript is saved. Lower the chunk size in Settings, then press Retry.`;
    case "auth":
      return `${destination} did not accept the saved key. Open Settings, check the key and press Test connection. Your transcript is saved.`;
    case "network":
      return `Could not reach ${destination}. Check the network connection, then press Retry. Your transcript and finished parts are saved.`;
    case "server":
      return `${destination} had a temporary problem (HTTP ${error.status ?? "unknown"}). Your transcript and finished parts are saved. Press Retry in a minute.`;
    case "cancelled":
      return "Stopped. Your transcript and any finished parts are saved. Press Retry to continue where it stopped.";
    default:
      return `${destination} could not write the summary: ${error.message || "unknown error"}. Your transcript is saved.`;
  }
}

