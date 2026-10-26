export interface Case {
  id: string;
  name: string;
  description: string;
  created_at: string;
  recordings?: Recording[];
  timeline_report?: string | null;
  timeline_meta?: ReportMeta | null;
}

export interface ReportMeta {
  engine: string | null;
  model: string | null;
  requestId: string | null;
  transcriptId: string | null;
  generatedAt: string | null;
  truncated?: boolean;
  /** Set when the report is generated. Later exports keep this time. */
  aiAcknowledgedAt?: string | null;
  aiAcknowledgedLabel?: string | null;
  /** Who wrote it: "AssemblyAI", "the local model on this PC" or "Google Gemini". */
  service?: string | null;
  /** SHA-256 of the original recording as imported, recorded when the summary was written. */
  sourceSha256?: string | null;
  sourceHashAt?: string | null;
  machineGenerated?: boolean;
  partCount?: number;
  resumedParts?: number;
  appVersion?: string | null;
}

export interface Recording {
  id: string;
  case_id: string;
  filename: string;
  transcription_filename: string | null;
  original_name: string;
  mime_type: string;
  size: number;
  transcript: TranscriptData | null;
  summary: string | null;
  apod_results: ApodResult[] | null;
  speaker_labels: Record<string, string> | null;
  interview_type?: string | null;
  report_meta?: ReportMeta | null;
  aai_deleted_at?: string | null;
  has_transcript?: boolean;
  created_at: string;
  /** SHA-256 of the original audio or video as imported. */
  source_sha256?: string | null;
  source_hash_at?: string | null;
  /** Set only after a person confirmed the review. */
  reviewed_by?: string | null;
  reviewed_at?: string | null;
}

export interface TranscriptData {
  text: string;
  utterances: Utterance[];
  words: Word[];
  id?: string;
  speech_understanding?: any;
  summary?: string;
}

export interface Utterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  words: Word[];
}

export interface Word {
  text: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: string;
}

export interface ApodResult {
  pattern: string;
  engaged: boolean;
  explanation: string;
  evidence: string;
}
