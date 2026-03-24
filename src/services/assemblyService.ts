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
