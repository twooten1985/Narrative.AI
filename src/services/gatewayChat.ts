import { DEFAULT_GATEWAY_MODEL, FALLBACK_GATEWAY_MODEL, REPORT_MAX_TOKENS, REPORT_TEMPERATURE } from "./config";
import type { ChatMessage, ChatResult } from "./reportPipeline";

export async function gatewayChat(opts: {
  url: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
}): Promise<ChatResult> {
  const fetchImpl = opts.fetchImpl || fetch;
  const model = opts.model || DEFAULT_GATEWAY_MODEL;
  const fallback = model === FALLBACK_GATEWAY_MODEL ? DEFAULT_GATEWAY_MODEL : FALLBACK_GATEWAY_MODEL;
  const payload = {
    model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? REPORT_MAX_TOKENS,
    temperature: opts.temperature ?? REPORT_TEMPERATURE,
    fallbacks: [{ model: fallback }],
  };

  const response = await fetchImpl(opts.url, {
    method: "POST",
    headers: {
      authorization: opts.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    const requestId = result.request_id || "n/a";
    console.error(`[gateway] status=${response.status} request_id=${requestId} model=${model}`);
    throw new Error(result.error?.message || `LLM Gateway error ${response.status} (request_id=${requestId})`);
  }
  const choice = result.choices?.[0];
  const finish = choice?.finish_reason || choice?.stop_reason || result.stop_reason || null;
  console.log(`[gateway] ok model=${result.model || model} request_id=${result.request_id || "n/a"} finish=${finish || "n/a"}`);
  return {
    content: choice?.message?.content,
    model: result.model || model,
    requestId: result.request_id || null,
    finishReason: finish,
  };
}
