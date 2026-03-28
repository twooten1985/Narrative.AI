import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { APOD_PATTERNS, INTERVIEW_PROMPTS } from "../constants";

export async function generateSummary(transcript: string, type: string, apiKey?: string) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Gemini API Key is missing. Please add GEMINI_API_KEY to your environment variables or provide it in Settings.");
  }
  
  const ai = new GoogleGenAI({ apiKey: key });
  const prompt = INTERVIEW_PROMPTS[type as keyof typeof INTERVIEW_PROMPTS] || INTERVIEW_PROMPTS["Suspect Interview"];
  
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `
      System Instruction: You are an expert forensic analyst for law enforcement. Your task is to provide objective, factual summaries of sensitive interview material. Do not censor or omit details based on their graphic or sensitive nature, as they are critical for legal proceedings. Maintain a professional, clinical tone.
      
      Task: ${prompt}
      
      Transcript:
      ${transcript}
      
      Provide a detailed summary, key entities (names, locations), and sentiment analysis.
    `,
    config: {
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE },
      ]
    }
  });
  
  if (!response.text) {
    throw new Error("Gemini failed to generate a summary. The response was empty.");
  }
  
  return response.text;
}

export async function runApodAnalysis(transcript: string, apiKey?: string) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Gemini API Key is missing. Please add GEMINI_API_KEY to your environment variables or provide it in Settings.");
  }

  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `
      System Instruction: You are an expert forensic psychologist for law enforcement. Your task is to provide objective, factual analysis of sensitive interview material. Do not censor or omit details based on their graphic or sensitive nature. Maintain a professional, clinical tone.
      
      Task: Conduct a detailed APOD (Analysis of Patterns of Denial) assessment on the following transcript.
      For each of the 12 patterns, determine if it is present (Yes/No) and provide evidence (quotes/timestamps).
      
      Patterns to check:
      ${JSON.stringify(APOD_PATTERNS, null, 2)}
      
      Transcript:
      ${transcript}
      
      Return the result as a JSON array of objects with fields: pattern, engaged (boolean), explanation, and evidence (string).
    `,
    config: {
      responseMimeType: "application/json",
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE },
      ],
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            pattern: { type: Type.STRING },
            engaged: { type: Type.BOOLEAN },
            explanation: { type: Type.STRING },
            evidence: { type: Type.STRING }
          },
          required: ["pattern", "engaged", "explanation", "evidence"]
        }
      }
    }
  });
  
  return JSON.parse(response.text || "[]");
}
