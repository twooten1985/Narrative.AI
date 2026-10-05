import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-ai-"));
process.env.NARRATIVE_NO_AUTOSTART = "1";
process.env.APP_USER_DATA_PATH = userData;
process.env.LOCAL_AUTH_TOKEN = "integration-token-0123456789abcdef";
process.env.NODE_ENV = "test";
delete process.env.ASSEMBLY_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

const { createApp } = await import("../server.ts");

describe("local server", () => {
  let server: Server;
  let base = "";

  before(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(userData, { recursive: true, force: true });
  });

  const auth = { Authorization: `Bearer ${process.env.LOCAL_AUTH_TOKEN}` };

  it("rejects API and upload requests without the session token", async () => {
    const cases = await fetch(`${base}/api/cases`);
    assert.equal(cases.status, 401);
    const media = await fetch(`${base}/uploads/missing.mp3`);
    assert.equal(media.status, 401);
  });

  it("cleans a saved report after backing up the database", async () => {
    const created = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Case 12", description: "test" }),
    });
    assert.equal(created.status, 200);
    const caseRow = await created.json() as { id: string };

    const body = new FormData();
    body.append("file", new Blob(["not-audio"], { type: "audio/mpeg" }), "call.mp3");
    const uploaded = await fetch(`${base}/api/cases/${caseRow.id}/recordings`, {
      method: "POST",
      headers: auth,
      body,
    });
    assert.equal(uploaded.status, 200);
    const recording = await uploaded.json() as { id: string };

    const poisoned = `<reasoning>The user wants a report. You write investigative reports for a law enforcement agency from recorded interview and call transcripts.</reasoning>
Here is the report:
## 1. Case Information
- **Case:** Case 12
Use only information contained in the transcript. Do not add facts, names, dates, motives, or conclusions that are not stated in it.`;
    const patched = await fetch(`${base}/api/recordings/${recording.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ summary: poisoned, interview_type: "Jail Phone Calls" }),
    });
    assert.equal(patched.status, 200);

    const cleaned = await fetch(`${base}/api/maintenance/clean-reports`, { method: "POST", headers: auth });
    assert.equal(cleaned.status, 200);
    const result = await cleaned.json() as { backupPath: string; recordingsChanged: number };
    assert.equal(result.recordingsChanged, 1);
    assert.equal(fs.existsSync(result.backupPath), true);

    const stored = await fetch(`${base}/api/recordings/${recording.id}`, { headers: auth });
    const row = await stored.json() as { summary: string };
    assert.equal(row.summary.startsWith("## 1. Case Information"), true);
    assert.equal(row.summary.includes("<reasoning>"), false);
    assert.equal(row.summary.includes("You write investigative reports"), false);
    assert.equal(row.summary.includes("Use only information contained in the transcript"), false);
  });

  it("refuses Gemini when the setting is off", async () => {
    const response = await fetch(`${base}/api/reports/jobs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: "gemini",
        reportType: "Suspect Interview",
        transcript: { text: "hello", id: "tr" },
      }),
    });
    assert.equal(response.status, 403);
    const payload = await response.json() as { code?: string };
    assert.equal(payload.code, "GEMINI_DISABLED");
  });
});
