/**
 * "Test connection" for Settings. Three separate checks, each answered in plain words, so a
 * person can tell a bad key from a busy summary service. Only synthetic text is ever sent.
 */
import { testAssemblyAiKey } from "./keyTest";
import { gatewayChat, redactForLog } from "./gatewayChat";
import { describeGatewayError, isGatewayError } from "./gatewayErrors";

export interface CheckResult {
  ok: boolean;
  /** One short sentence a non-technical reader can act on. */
  message: string;
}

export interface ConnectionTestResult {
  provider: "gateway" | "local" | "off";
  key: CheckResult;
  transcription: CheckResult;
  summary: CheckResult;
  summaryModel: string;
}

export interface ConnectionTestOptions {
  provider: "gateway" | "local" | "off";
  apiBase: string;
  gatewayUrl: string;
  apiKey: string;
  gatewayModel: string;
  localUrl: string;
  localModel: string;
  fetchImpl?: typeof fetch;
  /** Wraps the summary call (for the shared queue). */
  runSummary?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const SKIPPED: CheckResult = { ok: true, message: "Not used with this setting." };

async function checkTranscription(opts: ConnectionTestOptions): Promise<CheckResult> {
  if (!opts.apiKey) return { ok: false, message: "No AssemblyAI key is saved, so transcription cannot start." };
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    // An empty request is refused for being incomplete, which proves the key reaches the
    // transcription service without creating (or paying for) a transcript.
    const response = await fetchImpl(`${opts.apiBase.replace(/\/$/, "")}/v2/transcript`, {
      method: "POST",
      headers: { authorization: opts.apiKey, "content-type": "application/json" },
      body: "{}",
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: "AssemblyAI does not allow this key to transcribe. Check the key and the account status." };
    }
    if (response.status === 429) {
      return { ok: false, message: "AssemblyAI is limiting requests right now. Wait a minute and test again." };
    }
    if (response.status >= 500) {
      return { ok: false, message: `AssemblyAI had a problem on its side (HTTP ${response.status}). Try again in a few minutes.` };
    }
    return { ok: true, message: "Transcription is reachable and the key is allowed to use it." };
  } catch (error: any) {
    return { ok: false, message: `Could not reach AssemblyAI: ${redactForLog(String(error?.message || error), opts.apiKey)}` };
  }
}

async function checkSummary(opts: ConnectionTestOptions): Promise<{ result: CheckResult; model: string }> {
  const local = opts.provider === "local";
  const model = local ? opts.localModel : opts.gatewayModel;
  if (opts.provider === "off") return { result: { ok: true, message: "Summaries are turned off in Settings." }, model: "" };
  if (local && !model.trim()) {
    return { result: { ok: false, message: "No local model name is set. Type the model name, for example llama3.1." }, model };
  }
  if (!local && !opts.apiKey) return { result: { ok: false, message: "No AssemblyAI key is saved, so summaries cannot run." }, model };
  const run = opts.runSummary || (async <T,>(fn: () => Promise<T>) => fn());
  try {
    const reply = await run(() =>
      gatewayChat({
        url: local ? `${opts.localUrl.replace(/\/$/, "")}/chat/completions` : opts.gatewayUrl,
        apiKey: local ? "" : opts.apiKey,
        model,
        provider: local ? "local" : "gateway",
        messages: [
          { role: "system", content: "You are a connection test. Reply with the single word OK." },
          { role: "user", content: "Test message with no case information." },
        ],
        maxTokens: 16,
        temperature: 0,
        maxAttempts: 1,
        allowModelFallback: false,
        fetchImpl: opts.fetchImpl,
      })
    );
    const where = local ? "the local model on this PC" : "AssemblyAI";
    return { result: { ok: true, message: `${where} answered a short test using ${reply.model || model}. No case text was sent.` }, model: reply.model || model };
  } catch (error: any) {
    if (isGatewayError(error)) {
      return { result: { ok: false, message: describeGatewayError(error, local ? "the local model" : "AssemblyAI") }, model };
    }
    const text = redactForLog(String(error?.message || error), opts.apiKey);
    return {
      result: {
        ok: false,
        message: local
          ? `Could not reach the local model at ${opts.localUrl}. Is Ollama running? (${text})`
          : `Could not reach the AssemblyAI summary service: ${text}`,
      },
      model,
    };
  }
}

export async function testConnection(opts: ConnectionTestOptions): Promise<ConnectionTestResult> {
  const fetchImpl = opts.fetchImpl;
  const key: CheckResult = opts.provider === "local" && !opts.apiKey
    ? { ok: true, message: "No AssemblyAI key is saved. That is fine for the local model, but transcription needs one." }
    : await testAssemblyAiKey({ apiBase: opts.apiBase, apiKey: opts.apiKey, fetchImpl });
  const transcription = opts.apiKey ? await checkTranscription(opts) : { ok: false, message: "No AssemblyAI key is saved, so transcription cannot start." };
  const { result, model } = await checkSummary(opts);
  return { provider: opts.provider, key, transcription, summary: result, summaryModel: model };
}

export { SKIPPED as NOT_USED_RESULT };