import { AssemblyAI } from 'assemblyai';
import type { CaseInfo } from './reportPrompts';
import { apiFetch } from './apiClient';

// We'll initialize this with the key from the user or environment
export const getAssemblyAIClient = (apiKey: string) => {
  return new AssemblyAI({
    apiKey: apiKey
  });
};

export const transcribeAudio = async (apiKey: string, audioUrl: string) => {
  const client = getAssemblyAIClient(apiKey);
  
  const transcript = await client.transcripts.transcribe({
    audio: audioUrl,
    speaker_labels: true,
  });
  
  return transcript;
};

export interface GatewayReportRequest {
  reportType: string;                       // built-in type name, or the custom prompt's name
  customInstructions?: string;              // only for user-defined report types
  speakerLabels?: Record<string, string>;   // e.g. { A: "Det. Smith", B: "John Doe" }
  caseInfo?: CaseInfo;
}

// Sends structured fields, NOT a pre-concatenated prompt string. The server builds the
// system/user messages from reportPrompts.ts and sanitizes the model output.
export const runLemurTask = async (_apiKey: string, transcriptId: string, req: GatewayReportRequest, model?: string) => {
  const data = await apiFetch(`/api/lemur`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcriptId, model, ...req })
  });
  if (data.truncated) {
    console.warn("LLM Gateway report hit max_tokens and may be incomplete.");
    return `${data.response}\n\n> NOTE: This report reached the model's length limit and may be incomplete. Regenerate or review against the transcript.`;
  }
  return data.response as string;
};
