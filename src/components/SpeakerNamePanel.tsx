import { useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";
import type { SpeakerSuggestion } from "../services/speakerNames";

export function SpeakerNamePanel({
  recordingId,
  speakerLabels,
  onLabels,
  onSave,
}: {
  recordingId: string;
  speakerLabels: Record<string, string>;
  onLabels: (next: Record<string, string>) => void;
  onSave: (next: Record<string, string>) => void;
}) {
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<SpeakerSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    apiFetch(`/api/recordings/${recordingId}/speakers`)
      .then((payload) => {
        if (cancelled) return;
        setSpeakers(Array.isArray(payload.speakers) ? payload.speakers.map(String) : []);
        setSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load speakers.");
      });
    return () => { cancelled = true; };
  }, [recordingId]);

  const ids = speakers.length > 0 ? speakers : Object.keys(speakerLabels);
  if (ids.length === 0 && !error) return null;

  const unused = suggestions.filter((item) => {
    const saved = (speakerLabels[item.speaker] || "").trim();
    return saved !== item.name;
  });

  const apply = (speaker: string, name: string) => {
    const next = { ...speakerLabels, [speaker]: name };
    onLabels(next);
    onSave(next);
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3" data-testid="speaker-name-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-orange-500">Speaker names</p>
          <p className="mt-1 text-[11px] leading-relaxed text-white/45">
            AssemblyAI labels speakers with letters. Rename a speaker here and regenerate the narrative. Suggestions are taken only from words in the transcript. Unknown speakers stay Speaker A, Speaker B, and so on.
          </p>
        </div>
        {unused.length > 0 && (
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg bg-orange-500 text-white text-[10px] font-bold uppercase tracking-wider"
            onClick={() => {
              const next = { ...speakerLabels };
              for (const item of unused) next[item.speaker] = item.name;
              onLabels(next);
              onSave(next);
            }}
          >
            Use suggested names
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <div className="grid gap-3">
        {ids.map((speaker) => {
          const suggestion = suggestions.find((item) => item.speaker === speaker);
          return (
            <div key={speaker} className="grid gap-1">
              <label className="text-[10px] font-bold uppercase tracking-widest text-white/40" htmlFor={`speaker-${speaker}`}>
                Speaker {speaker}
              </label>
              <input
                id={`speaker-${speaker}`}
                data-testid={`speaker-name-${speaker}`}
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-orange-400 focus:border-orange-500/50 focus:outline-none"
                placeholder={`Speaker ${speaker}`}
                value={speakerLabels[speaker] || ""}
                onChange={(event) => {
                  const next = { ...speakerLabels };
                  const value = event.target.value;
                  if (!value.trim()) delete next[speaker];
                  else next[speaker] = value;
                  onLabels(next);
                }}
                onBlur={(event) => {
                  const next = { ...speakerLabels };
                  const value = event.currentTarget.value;
                  if (!value.trim()) delete next[speaker];
                  else next[speaker] = value;
                  onLabels(next);
                  onSave(next);
                }}
              />
              {suggestion && (speakerLabels[speaker] || "").trim() !== suggestion.name && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/50">
                  <span>Suggested: {suggestion.name}</span>
                  <span className="italic text-white/35">“{suggestion.evidence}”</span>
                  <button
                    type="button"
                    className="rounded-md bg-white/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white"
                    onClick={() => apply(speaker, suggestion.name)}
                  >
                    Use this name
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
