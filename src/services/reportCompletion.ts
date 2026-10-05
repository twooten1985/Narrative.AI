import { REPORT_MAX_TOKENS, REPORT_TEMPERATURE } from "./config";
import { sanitizeContinuation, sanitizeReport, type SanitizeOptions } from "./sanitizeReport";
import { estimateTokens } from "./transcriptChunks";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatResult {
  content: string | null | undefined;
  model?: string | null;
  requestId?: string | null;
  finishReason?: string | null;
}

export type ChatFn = (args: {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  model: string;
}) => Promise<ChatResult>;

export interface BuiltMessages {
  system: string;
  user: string;
  firstHeading: string;
  instructionText: string;
}

/**
 * Per-call output cap.
 * Claude on the AssemblyAI gateway is requested at 16,000 tokens.
 * gpt-oss counts hidden reasoning against the same max_tokens, so a small cap
 * returns finish_reason "length" with an empty or cut-off report. Its context
 * is 131,072 tokens; 32,000 leaves room for reasoning and a visible report.
 * Gemini uses the same number as maxOutputTokens. None of these are a ceiling
 * on the saved report: a "length" finish is continued, then merged in pieces.
 */
export function completionMaxTokens(model: string): number {
  const id = (model || "").toLowerCase();
  if (id.includes("gpt-oss")) return 32000;
  if (id.includes("gemini")) return 32768;
  return REPORT_MAX_TOKENS;
}

/** How much source text one merge should try to rewrite, under the visible output budget. */
export function visibleOutputBudget(model: string): number {
  const id = (model || "").toLowerCase();
  if (id.includes("gpt-oss")) return 8000;
  if (id.includes("gemini")) return 20000;
  return 12000;
}

export function isTruncatedFinish(finishReason?: string | null): boolean {
  const value = (finishReason || "").toLowerCase();
  return value === "length" || value === "max_tokens" || value === "max_tokens_exceeded";
}

export function stitchReport(previous: string, next: string): string {
  const head = previous.trimEnd();
  const tail = next.trim();
  if (!tail) return head;
  if (!head) return tail;
  if (head.includes(tail)) return head;
  const max = Math.min(head.length, tail.length, 2500);
  for (let size = max; size >= 40; size--) {
    if (head.slice(-size) === tail.slice(0, size)) return head + tail.slice(size);
  }
  return `${head}\n\n${tail}`;
}

function continuationUser(originalUser: string, soFar: string): string {
  const ending = soFar.slice(-6000);
  return `${originalUser}

<report_so_far_ending>
${ending}
</report_so_far_ending>

Continue the report from the cutoff. The text above is only the ending of the report already written. Do not repeat it. Do not restart at the first heading. Finish every remaining section through the final section.`;
}

export interface CompletionResult {
  text: string;
  model: string;
  requestId: string | null;
  truncated: boolean;
  calls: number;
}

export async function completeWithContinuation(opts: {
  chat: ChatFn;
  model: string;
  messages: BuiltMessages;
  maxTokens?: number;
  temperature?: number;
  maxContinuations?: number;
  sanitize?: SanitizeOptions;
}): Promise<CompletionResult> {
  const maxRounds = Math.max(1, opts.maxContinuations ?? 6);
  let assembled = "";
  let model = opts.model;
  let requestId: string | null = null;
  let truncated = false;
  let calls = 0;

  for (let round = 0; round < maxRounds; round++) {
    const result = await opts.chat({
      messages: [
        { role: "system", content: opts.messages.system },
        { role: "user", content: round === 0 ? opts.messages.user : continuationUser(opts.messages.user, assembled) },
      ],
      maxTokens: opts.maxTokens ?? completionMaxTokens(opts.model),
      temperature: opts.temperature ?? REPORT_TEMPERATURE,
      model: opts.model,
    });
    calls += 1;
    model = result.model || model;
    requestId = result.requestId || requestId;
    const piece = round === 0
      ? sanitizeReport(result.content, {
          firstHeading: opts.messages.firstHeading,
          instructionText: opts.messages.instructionText,
          ...opts.sanitize,
        })
      : sanitizeContinuation(result.content);
    const cut = isTruncatedFinish(result.finishReason);
    if (!piece) {
      if (round === 0 && !cut) {
        throw new Error(
          `The model returned an empty report (finish_reason=${result.finishReason || "unknown"}, request_id=${result.requestId || "n/a"}).`
        );
      }
      truncated = cut;
      if (!cut) break;
      continue;
    }
    assembled = stitchReport(assembled, piece);
    if (!cut) {
      truncated = false;
      break;
    }
    truncated = true;
  }

  if (!assembled) {
    throw new Error(`The model returned an empty report (request_id=${requestId || "n/a"}).`);
  }
  return { text: assembled, model, requestId, truncated, calls };
}

export interface MergeItem {
  rangeLabel: string;
  text: string;
}

/** Group items so each merge stays under tokenBudget. One item is never split. */
export function groupMergeItems(items: MergeItem[], tokenBudget: number): MergeItem[][] {
  const groups: MergeItem[][] = [];
  let current: MergeItem[] = [];
  let tokens = 0;
  const limit = Math.max(1, tokenBudget);
  for (const item of items) {
    const cost = estimateTokens(item.text) + 30;
    if (current.length > 0 && tokens + cost > limit) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
