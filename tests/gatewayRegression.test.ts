// 6.1.6 regression tests for the summary service. Mocked fetch only: no network, no real key, synthetic text.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gatewayChat } from "../src/services/gatewayChat.ts";
import { GatewayError, isGatewayError } from "../src/services/gatewayErrors.ts";
import { generateInvestigativeReport, createMemoryPartialStore, type ChatFn } from "../src/services/reportPipeline.ts";
import { decideEngine, destinationNote } from "../src/services/summaryEngine.ts";

const URL_GATEWAY = "https://llm-gateway.example.test/v1/chat/completions";
const KEY = "sk-SYNTHETIC-KEY-1234567890";
const MESSAGES = [{ role: "user" as const, content: "Summarize: the witness saw a gray car." }];
const OK_BODY = { request_id: "req_ok", model: "claude-sonnet-4-6", choices: [{ message: { content: "## 1. Case Information\nok" }, finish_reason: "stop" }] };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function scripted(responses: (Response | Error)[]) {
  const calls: { url: string; body: any; headers: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const noSleep = async () => {};

function base(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return { url: URL_GATEWAY, apiKey: KEY, model: "claude-sonnet-4-6", messages: MESSAGES, fetchImpl, sleepImpl: noSleep, random: () => 0, log: () => {}, ...extra };
}

describe("summary service regressions (6.1.6)", () => {
  it("1. waits for Retry-After on a flat 429 body, then succeeds", async () => {
    const { calls, fetchImpl } = scripted([
      json(429, { request_id: "req_a", message: "Rate limit exceeded: too many requests", code: 429 }, { "retry-after": "7" }),
      json(200, OK_BODY),
    ]);
    const sleeps: number[] = [];
    const retries: any[] = [];
    const result = await gatewayChat(base(fetchImpl, { sleepImpl: async (ms: number) => { sleeps.push(ms); }, onRetry: (i: any) => retries.push(i) }) as any);
    assert.equal(calls.length, 2);
    assert.equal(result.attempts, 2);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 7000 && sleeps[0] <= 8000, `waited ${sleeps[0]} ms`);
    assert.equal(retries[0].attempt, 2);
    assert.equal(retries[0].kind, "rate_limit_rpm");
    assert.match(retries[0].message, /Rate limit exceeded/);
  });

  it("2. a tokens-per-minute 429 is classified as TPM and keeps the real message", async () => {
    const message = "Rate limit exceeded: 85,000 tokens per minute (TPM) for this account";
    const { fetchImpl } = scripted([json(429, { request_id: "req_t", message, code: 429 })]);
    await assert.rejects(
      gatewayChat(base(fetchImpl, { maxAttempts: 1 }) as any),
      (error: unknown) => {
        assert.ok(isGatewayError(error));
        const e = error as GatewayError;
        assert.equal(e.kind, "rate_limit_tpm");
        assert.equal(e.status, 429);
        assert.equal(e.message, message);
        assert.equal(e.requestId, "req_t");
        assert.equal(/gemini|google/i.test(e.message), false);
        return true;
      },
    );
  });

  it("3. a 502 with an empty body is retried 5 times, then reported with its status", async () => {
    const { calls, fetchImpl } = scripted([new Response("", { status: 502 })]);
    const sleeps: number[] = [];
    await assert.rejects(
      gatewayChat(base(fetchImpl, { sleepImpl: async (ms: number) => { sleeps.push(ms); } }) as any),
      (error: unknown) => {
        const e = error as GatewayError;
        assert.equal(e.kind, "server");
        assert.equal(e.status, 502);
        assert.equal(e.attempts, 5);
        assert.match(e.message, /HTTP 502/);
        return true;
      },
    );
    assert.equal(calls.length, 5);
    assert.equal(sleeps.length, 4);
    assert.ok(sleeps.every((ms, i) => i === 0 || ms >= sleeps[i - 1]), "backoff does not shrink");
    assert.ok(sleeps.every((ms) => ms <= 60_000));
  });

  it("4. a rate-limited fallback model still ends in one clear error; fallbacks are off by default", async () => {
    const limited = json(429, { request_id: "req_f", message: "Rate limit exceeded on fallback model too", code: 429 });
    const off = scripted([limited]);
    await assert.rejects(gatewayChat(base(off.fetchImpl, { maxAttempts: 2 }) as any));
    assert.equal(off.calls.every((c) => c.body.fallbacks === undefined), true);

    const on = scripted([limited]);
    await assert.rejects(
      gatewayChat(base(on.fetchImpl, { maxAttempts: 2, allowModelFallback: true }) as any),
      (error: unknown) => {
        const e = error as GatewayError;
        assert.equal(e.kind, "rate_limit_rpm");
        assert.match(e.message, /fallback model/);
        return true;
      },
    );
    assert.deepEqual(on.calls[0].body.fallbacks, [{ model: "gpt-oss-120b" }]);
    assert.equal(on.calls.length, 2);
  });

  it("5. a size error splits the piece in half and the report still finishes", async () => {
    const utterances = Array.from({ length: 8 }, (_, i) => ({ speaker: i % 2 ? "B" : "A", start: i * 60_000, end: i * 60_000 + 4000, text: `statement ${i} `.repeat(40) }));
    let sizeFailures = 0;
    const seen: number[] = [];
    const chat: ChatFn = async (args) => {
      const user = args.messages.map((m) => m.content).join("\n");
      seen.push(user.length);
      if (user.length > 6000 && /Part \d+|transcript/i.test(user) && sizeFailures < 3 && !/Merge|merge/.test(args.messages[0].content.slice(0, 200))) {
        sizeFailures += 1;
        throw new GatewayError({ status: 429, kind: "size", message: "Request too large for this account. Limit 30000, Requested 45000", limits: { limitTokens: 30000, requestedTokens: 45000 } });
      }
      return { content: "## 1. Case Information\n- ok", model: "claude-sonnet-4-6", requestId: "req_s", finishReason: "stop" };
    };
    const result = await generateInvestigativeReport({
      reportType: "Witness Interview",
      transcript: { id: "tr_size", utterances },
      model: "claude-sonnet-4-6",
      tokenLimit: 100_000,
      chat,
    });
    assert.ok(sizeFailures >= 1, "the test must trigger a size error");
    assert.ok((result as any).sizeSplits >= 1);
    assert.match(result.text, /Case Information/);
  });

  it("6. cancel during the back-off wait stops quickly with a 'cancelled' error", async () => {
    const { calls, fetchImpl } = scripted([json(429, { message: "Rate limit exceeded", code: 429 }, { "retry-after": "30" })]);
    const controller = new AbortController();
    const started = Date.now();
    const pending = gatewayChat({ ...base(fetchImpl), sleepImpl: undefined, signal: controller.signal } as any);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (error: unknown) => (error as GatewayError).kind === "cancelled");
    assert.ok(Date.now() - started < 3000, "did not wait out the 30 second hint");
    assert.equal(calls.length, 1);
  });

  it("7. a retry resumes from the saved chunk summaries instead of starting over", async () => {
    const utterances = Array.from({ length: 6 }, (_, i) => ({ speaker: i % 2 ? "B" : "A", start: i * 600_000, end: i * 600_000 + 4000, text: `statement number ${i} `.repeat(30) }));
    const store = createMemoryPartialStore();
    const part = (text: string) => /statement number (\d)/.exec(text)?.[1] ?? "?";
    const callsFirst: string[] = [];
    const failingChat: ChatFn = async (args) => {
      const user = args.messages.map((m) => m.content).join("\n");
      callsFirst.push(part(user));
      if (callsFirst.length === 3) throw new GatewayError({ status: 503, kind: "server", message: "Service unavailable", attempts: 5 });
      return { content: `## 1. Case Information\n- part ${part(user)}`, model: "m", requestId: "r", finishReason: "stop" };
    };
    const opts = { reportType: "Witness Interview", transcript: { id: "tr_resume", utterances }, model: "claude-sonnet-4-6", tokenLimit: 80, partialStore: store };
    await assert.rejects(generateInvestigativeReport({ ...opts, chat: failingChat }), (e: unknown) => isGatewayError(e));
    assert.equal(store.entries.size >= 1, true, "finished chunk summaries were saved");
    const savedBefore = store.entries.size;

    const callsSecond: string[] = [];
    const okChat: ChatFn = async (args) => {
      const user = args.messages.map((m) => m.content).join("\n");
      callsSecond.push(part(user));
      return { content: `## 1. Case Information\n- part ${part(user)}`, model: "m", requestId: "r", finishReason: "stop" };
    };
    const result = await generateInvestigativeReport({ ...opts, chat: okChat });
    assert.match(result.text, /Case Information/);
    assert.equal((result as any).resumedParts, savedBefore, "every saved chunk summary was reused");
    assert.equal(callsSecond.length, 1, "only the merge call was made on retry");
    assert.equal(callsFirst.length, 3, "the first run made two chunk calls and failed on the merge");  });

  it("8. the API key never appears in log lines", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const echoing = scripted([json(401, { request_id: "req_k", message: `Invalid API key ${KEY} for this account`, code: 401 })]);
    await assert.rejects(gatewayChat(base(echoing.fetchImpl, { log }) as any));
    const net = scripted([Object.assign(new Error(`connect failed for ${KEY}`), { code: "ECONNRESET" })]);
    await assert.rejects(gatewayChat(base(net.fetchImpl, { log, maxAttempts: 2 }) as any));
    const good = scripted([json(200, OK_BODY)]);
    await gatewayChat(base(good.fetchImpl, { log }) as any);
    assert.ok(lines.length >= 3);
    for (const line of lines) assert.equal(line.includes(KEY), false, line);
  });

  it("9. there is no automatic cloud fallback, in the engine rules or in the call path", async () => {
    const settings = { summaryProvider: "local" as const, allowGemini: true, localLlmUrl: "http://127.0.0.1:11434/v1", localLlmModel: "llama3.1" };
    const blocked = decideEngine({ requested: "gateway", settings, hasAssemblyKey: true, hasGeminiKey: true });
    assert.equal(blocked.ok, false);
    assert.equal((blocked as any).code, "CLOUD_BLOCKED_LOCAL_ONLY");

    const cloud = { ...settings, summaryProvider: "gateway" as const };
    const needsClick = decideEngine({ requested: "local", settings: cloud, hasAssemblyKey: true, hasGeminiKey: false });
    assert.equal((needsClick as any).code, "LOCAL_NEEDS_CLICK");
    assert.equal(decideEngine({ requested: "local", settings: cloud, explicitLocal: true, hasAssemblyKey: true, hasGeminiKey: false }).ok, true);
    assert.equal((decideEngine({ settings: { ...cloud, summaryProvider: "off" }, hasAssemblyKey: true, hasGeminiKey: true }) as any).code, "SUMMARY_OFF");
    assert.equal((decideEngine({ requested: "gemini", settings: { ...cloud, allowGemini: false }, hasAssemblyKey: true, hasGeminiKey: true }) as any).code, "GEMINI_DISABLED");
    assert.equal((decideEngine({ settings: { ...settings, localLlmUrl: "https://example.com/v1" }, hasAssemblyKey: true, hasGeminiKey: false }) as any).code, "LOCAL_URL_NOT_LOCAL");

    // A failing local call must not reach any other host.
    const failing = scripted([new Error("fetch failed")]);
    await assert.rejects(gatewayChat({ ...base(failing.fetchImpl, { maxAttempts: 3 }), url: "http://127.0.0.1:11434/v1/chat/completions", provider: "local" } as any));
    assert.equal(failing.calls.length, 3);
    assert.equal(new Set(failing.calls.map((c) => c.url)).size, 1);
    assert.equal(failing.calls[0].headers.authorization, undefined, "no cloud key is sent to the local model");
  });

  it("10. the Google note appears only when Gemini is involved", () => {
    assert.equal(/google/i.test(destinationNote("gateway")), true); // says "Nothing was sent to Google"
    assert.match(destinationNote("gateway"), /AssemblyAI/);
    assert.match(destinationNote("gateway"), /Nothing was sent to Google/);
    assert.equal(destinationNote("local").includes("Google"), false);
    assert.match(destinationNote("local"), /stayed on this PC/);
    assert.match(destinationNote("gemini"), /went to Google Gemini/);
    assert.match(destinationNote("gemini", { geminiBlocked: true }), /Google Gemini is turned off/);
    assert.equal(destinationNote(null), "");
    // The 429 text from the service is passed through without a Google line.
    const e = new GatewayError({ status: 429, kind: "rate_limit_rpm", message: "Rate limit exceeded" });
    assert.equal(/gemini|google/i.test(e.message), false);
  });
});