import { REPORT_SPECS } from "./reportPrompts";

export const APOD_PATTERNS = {
  "Crime Perpetrated by Someone Else": "Suspect indicates abuse occurred but attributes it to another person.",
  "Denigration of the Victim/Victim Initiation": "Suspect claims victim initiated contact, was promiscuous, had mental health/behavior issues, or otherwise shifts blame to the victim.",
  "Asexuality": "Suspect describes themselves as uninterested in sex or physically unable to engage.",
  "Excessive Detail": "Suspect provides unnecessary, overly detailed information about unrelated events or topics.",
  "Graduated Pseudo-Admission": "Suspect gradually reveals more incriminating details over the course of the interview.",
  "Hedge Phrasing": "Frequent use of qualifiers like 'pretty much', 'basically', 'technically', 'mostly', 'usually', 'from what I remember', 'basically', or excessive pauses/hesitations.",
  "Hero/Victim": "Suspect portrays themselves as a hero/helper to the victim/family/community or seeks sympathy by claiming victimhood.",
  "Claim of Honesty": "Repeated assertions of honesty, such as 'I'm trying to be honest', 'honestly', 'I swear', 'really', 'seriously'.",
  "Religion": "Excessive mentions of God, faith, or religion as proof of innocence or character.",
  "Revenge/Out to Get Me": "Suspect claims accusation is motivated by revenge or secondary gain from victim or associates.",
  "Amnesia": "Frequent claims of memory loss regarding offense-related times/details.",
  "Legal Technicalities": "Focus on lack of evidence (e.g., no DNA), procedural issues, or corruption in legal process."
};

// Kept for the UI dropdowns (Object.keys(INTERVIEW_PROMPTS)) and the custom-prompt name check.
export const INTERVIEW_PROMPTS: Record<string, string> = Object.fromEntries(
  Object.entries(REPORT_SPECS).map(([name, spec]) => [name, spec.focus])
);
