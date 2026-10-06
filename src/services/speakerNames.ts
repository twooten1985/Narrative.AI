/**
 * Speaker letters come from AssemblyAI diarization (A, B, C). That API does not
 * return legal names. Names used in a report come from the user's saved map, or
 * from a quote in the transcript. A suggestion is kept only when the speaker's
 * own words state it, or the next speaker answers "state your name".
 */

export interface SpeakerSuggestion {
  speaker: string;
  name: string;
  evidence: string;
}

export interface SpeakerUtterance {
  speaker?: string | number | null;
  text?: string | null;
}

const TITLE =
  "(?:detective|det\\.?|officer|sgt\\.?|sergeant|lt\\.?|lieutenant|captain|cpt\\.?|agent|deputy|investigator)";
const INTRO =
  /\b(?:my name is|my name's|i am|i'm|this is)\b\s*/i;
const TITLE_RE = new RegExp(`^(?:${TITLE})\\s+`, "i");
const NAME_RE = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/;
const NAME_ASK =
  /\b(?:state your (?:full )?name|what is your (?:full )?name|identify yourself)\b/i;
const NOT_A_NAME = new Set([
  "sorry", "going", "not", "just", "here", "there", "fine", "good", "okay", "ok",
  "sure", "yeah", "yes", "no", "the", "recording", "uh", "um",
]);

const TITLE_CANON: Record<string, string> = {
  detective: "Detective",
  det: "Det.",
  officer: "Officer",
  sgt: "Sgt.",
  sergeant: "Sgt.",
  lt: "Lt.",
  lieutenant: "Lt.",
  captain: "Captain",
  cpt: "Captain",
  agent: "Agent",
  deputy: "Deputy",
  investigator: "Investigator",
};

function canonicalTitle(raw: string): string {
  const key = raw.toLowerCase().replace(/\./g, "").trim();
  return TITLE_CANON[key] || raw.trim();
}

function acceptableName(name: string): string | null {
  const cleaned = name.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 60) return null;
  const parts = cleaned.split(" ");
  if (parts.some((part) => NOT_A_NAME.has(part.toLowerCase()))) return null;
  return cleaned;
}

/** Name stated in this utterance, including an optional title. */
export function nameStatedInUtterance(text: string): string | null {
  const match = text.match(INTRO);
  if (!match || match.index === undefined) return null;
  let rest = text.slice(match.index + match[0].length).trim();
  const title = rest.match(TITLE_RE);
  let titleText = "";
  if (title) {
    titleText = canonicalTitle(title[0]);
    rest = rest.slice(title[0].length);
  }
  const name = rest.match(NAME_RE);
  if (!name) return null;
  return acceptableName(titleText ? `${titleText} ${name[1]}` : name[1]);
}

function answerToNameAsk(text: string): string | null {
  const reply = text.trim();
  if (!reply || reply.length > 120) return null;
  if (/^(i|my|uh|um|yes|no|yeah|okay)\b/i.test(reply)) return null;
  const name = reply.match(NAME_RE);
  if (!name) return null;
  return acceptableName(name[1]);
}

export function listSpeakers(transcript: { utterances?: SpeakerUtterance[] | null } | null | undefined): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const utterance of transcript?.utterances || []) {
    const id = String(utterance?.speaker ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}

export function suggestSpeakerNames(
  transcript: { utterances?: SpeakerUtterance[] | null } | null | undefined,
): SpeakerSuggestion[] {
  const utterances = Array.isArray(transcript?.utterances) ? transcript.utterances : [];
  const found = new Map<string, SpeakerSuggestion>();
  const remember = (speaker: string, name: string | null, evidence: string) => {
    if (!speaker || !name || found.has(speaker)) return;
    found.set(speaker, {
      speaker,
      name,
      evidence: evidence.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  };

  for (let i = 0; i < utterances.length; i++) {
    const utterance = utterances[i];
    const speaker = String(utterance?.speaker ?? "").trim();
    const text = String(utterance?.text || "");
    remember(speaker, nameStatedInUtterance(text), text);
    if (NAME_ASK.test(text)) {
      const next = utterances[i + 1];
      const nextSpeaker = String(next?.speaker ?? "").trim();
      if (next && nextSpeaker && nextSpeaker !== speaker) {
        remember(nextSpeaker, answerToNameAsk(String(next.text || "")), String(next.text || ""));
      }
    }
  }
  return [...found.values()];
}

export function savedSpeakerName(labels: Record<string, string> | null | undefined, speaker: string): string {
  const value = labels?.[speaker]?.trim() || "";
  if (!value || /^speaker\s+/i.test(value)) return "";
  return value.slice(0, 80);
}

export function speakerDisplayName(
  speaker: string,
  labels?: Record<string, string> | null,
): string {
  return savedSpeakerName(labels, speaker) || `Speaker ${speaker}`;
}

export function speakerNameInstructions(opts: {
  speakers?: string[];
  labels?: Record<string, string> | null;
  suggestions?: SpeakerSuggestion[];
  reportingOfficer?: string | null;
}): string {
  const labels = opts.labels || {};
  const suggestions = opts.suggestions || [];
  const ids = [...(opts.speakers || [])];
  for (const key of Object.keys(labels)) {
    if (savedSpeakerName(labels, key) && !ids.includes(key)) ids.push(key);
  }
  for (const suggestion of suggestions) {
    if (!ids.includes(suggestion.speaker)) ids.push(suggestion.speaker);
  }
  const officer = opts.reportingOfficer?.trim() || "";
  if (ids.length === 0 && !officer) return "";

  const lines = ids.map((id) => {
    const saved = savedSpeakerName(labels, id);
    if (saved) {
      return `- Speaker ${id} is ${saved}. Write "${saved}" every time. Do not write "Speaker ${id}" for this person.`;
    }
    const suggested = suggestions.find((item) => item.speaker === id);
    if (suggested) {
      const quote = suggested.evidence.replace(/[<>"]/g, "");
      return `- Speaker ${id} can be called "${suggested.name}" only because this transcript says: "${quote}". Do not use any other name. If that quote does not name this speaker, write "Speaker ${id}".`;
    }
    return `- Speaker ${id} has no name. Write "Speaker ${id}". Do not invent a name. Use "Unidentified male" or "Unidentified female" only when the transcript states that speaker's sex.`;
  });
  if (officer) {
    lines.push(`- The case file lists the reporting officer as ${officer}. Use that name for a speaker only when the map above already uses it, or when the transcript identifies that speaker as this officer.`);
  }
  return `<speaker_names>\n${lines.join("\n")}\n</speaker_names>`;
}
