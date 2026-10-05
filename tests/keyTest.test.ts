import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testAssemblyAiKey, testGeminiKey } from "../src/services/keyTest.ts";

describe("key tests", () => {
  it("accepts AssemblyAI when the list call succeeds and never returns the key", async () => {
    const secret = "assembly-secret-value";
    let seenAuth = "";
    const result = await testAssemblyAiKey({
      apiBase: "https://api.assemblyai.com",
      apiKey: secret,
      fetchImpl: async (url, init) => {
        seenAuth = String((init?.headers as Record<string, string>).authorization);
        assert.equal(String(url).includes("limit=1"), true);
        return new Response(JSON.stringify({ transcripts: [] }), { status: 200 });
      },
    });
    assert.equal(seenAuth, secret);
    assert.equal(result.ok, true);
    assert.equal(result.message.includes(secret), false);
  });

  it("redacts the key from an AssemblyAI error", async () => {
    const secret = "assembly-secret-value";
    const result = await testAssemblyAiKey({
      apiBase: "https://api.assemblyai.com",
      apiKey: secret,
      fetchImpl: async () => new Response(JSON.stringify({ error: `bad key ${secret}` }), { status: 401 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.message.includes(secret), false);
    assert.match(result.message, /\[key\]/);
  });

  it("calls Gemini with a header and reports a refusal without the key", async () => {
    const secret = "gemini-secret-value";
    const result = await testGeminiKey({
      apiKey: secret,
      model: "gemini-3.6-flash",
      fetchImpl: async (_url, init) => {
        const header = String((init?.headers as Record<string, string>)["x-goog-api-key"]);
        assert.equal(header, secret);
        return new Response(JSON.stringify({ error: { message: `denied ${secret}` } }), { status: 403 });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.message.includes(secret), false);
  });
});