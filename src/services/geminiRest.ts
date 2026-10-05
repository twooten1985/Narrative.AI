import { BASE_SYSTEM_PROMPT } from "./reportPrompts";
import { APOD_PATTERNS } from "./geminiService";

const GEMINI_MODEL = "gemini-3.6-flash";
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
];

function textFromGemini(result: any): string {
  const parts = result?.candidates?.[0]?.content?.parts || [];
  return parts.filter((part: any) => !part.thought).map((part: any) => part.text || "").join("");
}

export async function geminiGenerateContent(opts: {
  apiKey: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  json?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; model: string; finishReason: string | null }> {
  const fetchImpl = opts.fetchImpl || fetch;
  const generationConfig: Record<string, unknown> = {
    temperature: 0.1,
    maxOutputTokens: opts.maxOutputTokens ?? 32768,
  };
  if (opts.json) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          pattern: { type: "STRING" },
          engaged: { type: "BOOLEAN" },
          explanation: { type: "STRING" },
          evidence: { type: "STRING" },
        },
        required: ["pattern", "engaged", "explanation", "evidence"],
      },
    };
  }

  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [{ role: "user", parts: [{ text: opts.user }] }],
        generationConfig,
        safetySettings: SAFETY_SETTINGS,
      }),
    }
  );
  const result = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    throw new Error(result.error?.message || `Gemini API error (${response.status})`);
  }
  const finish = result?.candidates?.[0]?.finishReason || null;
  return {
    text: textFromGemini(result),
    model: GEMINI_MODEL,
    finishReason: finish === "MAX_TOKENS" ? "length" : finish,
  };
}

export function apodUserPrompt(transcriptBlock: string): { system: string; user: string } {
  return {
    system: `${BASE_SYSTEM_PROMPT}

Task: For each of the 12 APOD (Analysis of Patterns of Denial) categories provided, decide whether the transcript contains statements by the interview subject that fit the category. Set "engaged" to true only if you can quote at least one such statement. Put the verbatim quotes with [hh:mm:ss] timestamps in "evidence" and a one-sentence factual explanation in "explanation". If none, set engaged to false and evidence to "None noted in the transcript." A match means the statement fits the category; it is not a finding of deception. Return one object per category, in the order given.`,
    user: `<apod_categories>\n${JSON.stringify(APOD_PATTERNS, null, 2)}\n</apod_categories>\n\n<transcript>\n${transcriptBlock}\n</transcript>`,
  };
}

export const GEMINI_MODEL_ID = GEMINI_MODEL;
