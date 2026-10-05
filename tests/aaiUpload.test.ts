import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Agent } from "undici";
import {
  UPLOAD_BODY_TIMEOUT_MS,
  UPLOAD_HEADERS_TIMEOUT_MS,
  UPLOAD_MAX_ATTEMPTS,
  formatCauseChain,
  isTransientUploadFailure,
  streamUploadAudio,
  uploadDispatcherOptions,
  uploadFailureMessage,
} from "../src/services/aaiClient.ts";

function tempAudio(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-upload-"));
  const filePath = path.join(dir, "speech.mp3");
  fs.writeFileSync(filePath, Buffer.alloc(2048, 7));
  return filePath;
}

function fetchFailed(code: string, causeMessage: string): TypeError {
  const error = new TypeError("fetch failed");
  (error as TypeError & { cause?: unknown }).cause = Object.assign(new Error(causeMessage), { code });
  return error;
}

async function readBody(body: AsyncIterable<Buffer> | null | undefined): Promise<number> {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") return 0;
  let size = 0;
  for await (const chunk of body) size += chunk.length;
  return size;
}

describe("upload dispatcher", () => {
  it("keeps headers and body timeouts multi-hour so a slow upload is not cut at 300s", async () => {
    const options = uploadDispatcherOptions();
    assert.equal(UPLOAD_MAX_ATTEMPTS, 4);
    assert.ok(UPLOAD_HEADERS_TIMEOUT_MS >= 2 * 60 * 60 * 1000);
    assert.ok(UPLOAD_HEADERS_TIMEOUT_MS > 300_000);
    assert.ok(UPLOAD_BODY_TIMEOUT_MS >= 2 * 60 * 60 * 1000);
    assert.equal(options.headersTimeout, UPLOAD_HEADERS_TIMEOUT_MS);
    assert.equal(options.bodyTimeout, UPLOAD_BODY_TIMEOUT_MS);
    assert.ok(options.connectTimeout > 0 && options.connectTimeout < 120_000);
    assert.ok(options.keepAliveTimeout > 0);
    const agent = new Agent(options);
    await agent.close();
  });
});

describe("streamUploadAudio", () => {
  it("retries transient fetch failures with a fresh stream and then returns the upload url", async () => {
    const filePath = tempAudio();
    let calls = 0;
    let alive = 0;
    let maxAlive = 0;
    let created = 0;
    const delays: number[] = [];
    const retries: string[] = [];
    const progress: { attempt: number; loaded: number }[] = [];

    const uploadUrl = await streamUploadAudio({
      filePath,
      apiKey: "test-key",
      apiBase: "https://api.assemblyai.com",
      maxAttempts: 4,
      sleepImpl: async (ms) => { delays.push(ms); },
      openStream: (target) => {
        created += 1;
        alive += 1;
        maxAlive = Math.max(maxAlive, alive);
        const stream = fs.createReadStream(target);
        const original = stream.destroy.bind(stream);
        let closed = false;
        stream.destroy = ((error?: Error) => {
          if (!closed) {
            closed = true;
            alive -= 1;
          }
          return original(error);
        }) as typeof stream.destroy;
        return stream;
      },
      onRetry: (info) => retries.push(`${info.nextAttempt}/${info.attempts}:${info.reason}`),
      onProgress: (info) => progress.push({ attempt: info.attempt, loaded: info.loaded }),
      fetchImpl: async (_url, init) => {
        calls += 1;
        assert.equal((init.headers as Record<string, string>).authorization, "test-key");
        assert.equal((init.headers as Record<string, string>)["content-length"], "2048");
        if (calls < 3) throw fetchFailed("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error");
        const size = await readBody(init.body as AsyncIterable<Buffer>);
        assert.equal(size, 2048);
        return new Response(JSON.stringify({ upload_url: "https://cdn.example/upload" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(uploadUrl, "https://cdn.example/upload");
    assert.equal(calls, 3);
    assert.equal(created, 3);
    assert.equal(maxAlive, 1);
    assert.equal(alive, 0);
    assert.deepEqual(delays, [2000, 4000]);
    assert.deepEqual(retries, ["2/4:UND_ERR_HEADERS_TIMEOUT", "3/4:UND_ERR_HEADERS_TIMEOUT"]);
    assert.ok(progress.some((entry) => entry.attempt === 3 && entry.loaded === 2048));
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it("stops on a bad API key and does not retry", async () => {
    const filePath = tempAudio();
    let calls = 0;
    await assert.rejects(
      () => streamUploadAudio({
        filePath,
        apiKey: "bad",
        apiBase: "https://api.assemblyai.com/",
        sleepImpl: async () => { throw new Error("should not sleep"); },
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: "Authentication error" }), { status: 401 });
        },
      }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /rejected the API key/i);
        assert.match(message, /attempt 1\/4/);
        assert.match(formatCauseChain(error), /HTTP_401/);
        return true;
      },
    );
    assert.equal(calls, 1);
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it("does not retry a 400 and keeps the AssemblyAI error", async () => {
    const filePath = tempAudio();
    let calls = 0;
    await assert.rejects(
      () => streamUploadAudio({
        filePath,
        apiKey: "test-key",
        apiBase: "https://api.assemblyai.com",
        sleepImpl: async () => { throw new Error("should not sleep"); },
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: "unsupported file" }), { status: 400 });
        },
      }),
      /AssemblyAI rejected the upload \(400: unsupported file\)/,
    );
    assert.equal(calls, 1);
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it("retries 429 and 503, then records the cause after the last attempt", async () => {
    const filePath = tempAudio();
    const statuses = [429, 503, 503, 503];
    let calls = 0;
    await assert.rejects(
      () => streamUploadAudio({
        filePath,
        apiKey: "test-key",
        apiBase: "https://api.assemblyai.com",
        sleepImpl: async () => {},
        fetchImpl: async () => {
          const status = statuses[calls] || 503;
          calls += 1;
          return new Response(JSON.stringify({ error: "busy" }), { status });
        },
      }),
      (error: unknown) => {
        assert.match((error as Error).message, /AssemblyAI returned an error \(503: busy\)/);
        assert.match((error as Error).message, /attempt 4\/4/);
        assert.match(formatCauseChain(error), /HTTP_503/);
        assert.match(formatCauseChain(error), /cause=busy/);
        return true;
      },
    );
    assert.equal(calls, 4);
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it("passes the keep-alive dispatcher through to fetch", async () => {
    const filePath = tempAudio();
    let dispatcher: unknown;
    await streamUploadAudio({
      filePath,
      apiKey: "test-key",
      apiBase: "https://api.assemblyai.com",
      dispatcher: { id: "upload-agent" },
      fetchImpl: async (_url, init) => {
        dispatcher = init.dispatcher;
        await readBody(init.body as AsyncIterable<Buffer>);
        return new Response(JSON.stringify({ upload_url: "https://cdn.example/u" }), { status: 200 });
      },
    });
    assert.deepEqual(dispatcher, { id: "upload-agent" });
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });
});

describe("upload failure copy", () => {
  it("names a dropped connection instead of only saying fetch failed", () => {
    const error = fetchFailed("ECONNRESET", "socket hang up");
    assert.equal(isTransientUploadFailure(error), true);
    assert.match(uploadFailureMessage(error, 2, 4), /interrupted \(ECONNRESET\)/);
    assert.match(uploadFailureMessage(error, 2, 4), /attempt 2\/4/);
    assert.match(formatCauseChain(error), /code=ECONNRESET/);
    assert.match(formatCauseChain(error), /socket hang up/);
  });
});
