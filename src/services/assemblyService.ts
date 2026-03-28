import { AssemblyAI } from 'assemblyai';

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

export const runLemurTask = async (apiKey: string, transcriptId: string, prompt: string) => {
  const client = getAssemblyAIClient(apiKey);
  
  const response = await client.lemur.task({
    transcript_ids: [transcriptId],
    prompt: prompt,
    final_model: 'default',
  });
  
  return response.response;
};

export const LEMUR_PROMPTS = {
  "Suspect Interview": "You are an expert forensic analyst. Analyze this suspect interview transcript. Provide a detailed summary including significant statements, admissions, denials, and any contradictions. Format the output in clear markdown with sections for Summary, Key Admissions/Denials, and Contradictions.",
  "Witness Interview": "You are an expert forensic analyst. Analyze this witness interview transcript. Focus on alibis, timelines, and any contradictions with other known facts. Provide a detailed summary in markdown format.",
  "Victim Interview": "You are an expert forensic analyst. Analyze this victim interview transcript with extreme care and sensitivity. Focus on significant statements and emotional responses while maintaining an objective tone. Provide a detailed summary in markdown format.",
  "Forensic Child Interview": "You are an expert forensic analyst specializing in child interviews. Analyze this forensic child interview transcript. Use the child's specific language where possible, maintain an objective tone, and follow a chronological sequence. Provide a detailed summary in markdown format.",
  "Child Harm Suspect Interview": "You are an expert forensic analyst. Analyze this child harm suspect interview transcript. Provide a comprehensive summary and a detailed Analysis of Patterns of Denial (APOD). Identify any deceptive language or common patterns used by suspects in these cases. Format the output in clear markdown.",
  "Jail Phone Calls": "You are an expert forensic analyst. Analyze this jail phone call transcript. Identify the speakers and capture any significant statements, admissions, or key phrases. Provide a detailed summary in markdown format."
};
