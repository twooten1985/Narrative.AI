import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AI_DISCLAIMER, formatReportFooter } from "../services/audit";
import { BASE_SYSTEM_PROMPT, FIRST_HEADING, formatTranscriptForLLM } from "../services/reportPrompts";
import { generateInvestigativeReport, type ChatFn } from "../services/reportPipeline";
import { PROCESS_HEAP_MB } from "../services/memoryLimits";
import { testAssemblyAiKey } from "../services/keyTest";
import { DEFAULT_AAI_API_BASE } from "../services/config";

export interface RegressionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const CLEAN = `## 1. Case Information
- **Case:** Sample
## 2. Executive Summary
The subject stated the car was blue.`;

function poisoned() {
  return `<reasoning>The user wants a report. ${BASE_SYSTEM_PROMPT}</reasoning>\nHere is the report:\n${CLEAN}`;
}

function utterance(index: number, speaker: "A" | "B", text: string, startMin: number) {
  const start = startMin * 60 * 1000;
  return { speaker, start, end: start + 2000, text };
}

function longUtterances() {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push(utterance(i, i % 2 === 0 ? "A" : "B", `statement ${i} `.repeat(2000), i * 10));
  }
  return rows;
}

function ensureSamples(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ["short-interview.wav", "440", "1"],
    ["jail-call.wav", "523", "1"],
    ["long-interview.wav", "330", "2"],
  ] as const;
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const notes: string[] = [];
  for (const [name, freq, seconds] of files) {
    const dest = path.join(dir, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) continue;
    const result = spawnSync(ffmpeg, [
      "-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`,
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dest,
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      notes.push(`${name}: ffmpeg failed (${result.stderr?.slice(-180) || result.error?.message || "missing"})`);
    }
  }
  return notes.join("; ");
}

export async function runRegression(opts?: {
  samplesDir?: string;
  memoryLimitBytes?: number;
  live?: boolean;
}): Promise<{ ok: boolean; checks: RegressionCheck[]; heapUsed: number }> {
  const checks: RegressionCheck[] = [];
  const samplesDir = opts?.samplesDir || path.join(process.env.APP_USER_DATA_PATH || process.cwd(), "regression-samples");
  const memoryLimit = opts?.memoryLimitBytes ?? 512 * 1024 * 1024;
  const sampleNote = ensureSamples(samplesDir);
  const present = ["short-interview.wav", "jail-call.wav", "long-interview.wav"].filter((name) => fs.existsSync(path.join(samplesDir, name)));
  checks.push({
    name: "synthetic samples",
    ok: present.length === 3,
    detail: present.length === 3 ? `Found 3 tone files in ${samplesDir}.` : `Missing samples in ${samplesDir}. ${sampleNote}`,
  });

  const chat: ChatFn = async (args) => {
    const system = args.messages.find((m) => m.role === "system")?.content || "";
    if (!system.includes("Return only the report")) {
      throw new Error("system prompt missing");
    }
    return { content: poisoned(), model: "claude-sonnet-4-6", requestId: "req_regress", finishReason: "stop" };
  };

  const jailTranscript = {
    id: "tr_jail",
    utterances: [
      utterance(0, "A", "Did you call him", 0),
      utterance(1, "B", "I called him yesterday", 0.1),
    ],
  };
  const jailBlock = formatTranscriptForLLM(jailTranscript);
  checks.push({
    name: "jail speakers",
    ok: jailBlock.includes("Speaker A") && jailBlock.includes("Speaker B"),
    detail: jailBlock.split("\n")[0] || "empty",
  });

  const jailReport = await generateInvestigativeReport({
    reportType: "Jail Phone Calls",
    transcript: jailTranscript,
    model: "claude-sonnet-4-6",
    chat,
  });
  const jailArtifact = `${jailReport.text}\n\n${formatReportFooter({
    model: jailReport.model,
    requestId: jailReport.requestId,
    transcriptId: jailReport.transcriptId,
    generatedAt: new Date().toISOString(),
  })}`;
  checks.push({
    name: "no prompt echo",
    ok: jailArtifact.startsWith(FIRST_HEADING)
      && !jailArtifact.includes("<reasoning>")
      && !jailArtifact.includes("You write investigative reports"),
    detail: jailArtifact.slice(0, 80),
  });
  checks.push({
    name: "ai footer",
    ok: jailArtifact.includes(AI_DISCLAIMER) && jailArtifact.includes("req_regress") && jailArtifact.includes("tr_jail"),
    detail: "Footer and audit line checked on the jail report.",
  });

  let longCalls = 0;
  const longChat: ChatFn = async (args) => {
    longCalls += 1;
    return chat(args);
  };
  const longReport = await generateInvestigativeReport({
    reportType: "Suspect Interview",
    transcript: { id: "tr_long", utterances: longUtterances() },
    model: "claude-sonnet-4-6",
    chat: longChat,
  });
  checks.push({
    name: "long file chunked",
    ok: longReport.partCount >= 2 && longCalls === longReport.partCount + 1 && !longReport.text.includes("<reasoning>"),
    detail: `parts=${longReport.partCount} calls=${longCalls}`,
  });

  if (opts?.live || process.env.REGRESS_LIVE === "1") {
    const apiKey = process.env.ASSEMBLY_AI_API_KEY || "";
    if (!apiKey) {
      checks.push({ name: "live calls", ok: false, detail: "REGRESS_LIVE is set, but ASSEMBLY_AI_API_KEY is empty." });
    } else {
      const result = await testAssemblyAiKey({ apiBase: process.env.ASSEMBLYAI_API_BASE || DEFAULT_AAI_API_BASE, apiKey });
      checks.push({ name: "live calls", ok: result.ok, detail: result.message });
    }
  }

  const heapUsed = process.memoryUsage().heapUsed;
  checks.push({
    name: "memory",
    ok: heapUsed < memoryLimit,
    detail: `heapUsed=${heapUsed} limit=${memoryLimit} cage=${PROCESS_HEAP_MB}MB`,
  });

  return { ok: checks.every((c) => c.ok), checks, heapUsed };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]).endsWith(`${path.sep}runRegression.ts`);
if (isDirect) {
  runRegression({
    samplesDir: process.env.REGRESSION_SAMPLES || path.join(process.cwd(), "regression-samples"),
    live: process.env.REGRESS_LIVE === "1",
  }).then((result) => {
    for (const check of result.checks) {
      console.log(`${check.ok ? "ok" : "FAIL"}  ${check.name}: ${check.detail}`);
    }
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
