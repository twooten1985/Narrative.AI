export interface Case {
  id: string;
  name: string;
  description: string;
  created_at: string;
  recordings?: Recording[];
}

export interface Recording {
  id: string;
  case_id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  transcript: TranscriptData | null;
  summary: string | null;
  apod_results: ApodResult[] | null;
  speaker_labels: Record<string, string> | null;
  created_at: string;
}

export interface TranscriptData {
  text: string;
  utterances: Utterance[];
  words: Word[];
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
