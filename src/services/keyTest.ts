export interface KeyTestResult {
  ok: boolean;
  message: string;
}

function redact(message: string, secret: string): string {
  const text = String(message || "").slice(0, 400);
  if (!secret) return text;
  return text.split(secret).join("[key]");
}

export async function testAssemblyAiKey(opts: {
  apiBase: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<KeyTestResult> {
  if (!opts.apiKey) return { ok: false, message: "No AssemblyAI key is saved." };
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    const response = await fetchImpl(`${opts.apiBase.replace(/\/$/, "")}/v2/transcript?limit=1`, {
      headers: { authorization: opts.apiKey },
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      return { ok: false, message: redact(body.error || `AssemblyAI returned HTTP ${response.status}.`, opts.apiKey) };
    }
    return { ok: true, message: "AssemblyAI accepted the key." };
  } catch (error: any) {
    return { ok: false, message: redact(error?.message || "Could not reach AssemblyAI.", opts.apiKey) };
  }
}

export async function testGeminiKey(opts: {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<KeyTestResult> {
  if (!opts.apiKey) return { ok: false, message: "No Gemini key is saved." };
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}`,
      { headers: { "x-goog-api-key": opts.apiKey } }
    );
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok) {
      return {
        ok: false,
        message: redact(body.error?.message || `Gemini returned HTTP ${response.status}.`, opts.apiKey),
      };
    }
    return { ok: true, message: "Gemini accepted the key. No case data was sent." };
  } catch (error: any) {
    return { ok: false, message: redact(error?.message || "Could not reach Gemini.", opts.apiKey) };
  }
}
