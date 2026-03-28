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

export const INTERVIEW_PROMPTS = {
  "Suspect Interview": "Analyze and summarize suspect interviews for law enforcement. Capture significant statements, admissions, denials, and contradictions. Provide a chronological narrative with timestamps.",
  "Victim Interview": "Analyze and summarize victim interviews. Handle sensitive details (abuse, etc.) with care. Focus on significant statements and emotional responses.",
  "Witness Interview": "Analyze and summarize witness interviews. Focus on alibis, timelines, and contradictions with other evidence.",
  "Forensic Child Interview": "Expert summary of forensic child interviews. Use child's specific language, maintain objective tone, and follow chronological sequence.",
  "Jail Phone Calls": "Summarize inmate phone conversations. Identify speakers and capture key phrases or admissions.",
  "Child Harm Suspect Interview": "Specialized analysis for child harm cases. Includes full APOD (Analysis of Patterns of Denial) assessment."
};
