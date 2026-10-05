import React, { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Plus, Search, User } from "lucide-react";
import { apiFetch } from "../services/apiClient";
import type { Utterance } from "../types";

function formatClock(ms: number) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function TranscriptList({
  recordingId,
  speakerLabels,
  onSpeakerLabel,
  onSaveLabels,
  currentTimeMs,
  onSeek,
}: {
  recordingId: string;
  speakerLabels: Record<string, string>;
  onSpeakerLabel: (speaker: string, name: string) => void;
  onSaveLabels: () => void;
  currentTimeMs: number;
  onSeek: (seconds: number) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<number, Utterance>());
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cache.current.clear();
    setTotal(0);
    setError(null);
    let cancelled = false;
    apiFetch(`/api/recordings/${recordingId}/utterances?offset=0&limit=1&words=0`)
      .then((page) => { if (!cancelled) setTotal(page.total || 0); })
      .catch((err) => { if (!cancelled) setError(err.message || "Could not load the transcript."); });
    return () => { cancelled = true; };
  }, [recordingId]);

  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setMatchCount(null);
      return;
    }
    const handle = setTimeout(() => {
      apiFetch(`/api/recordings/${recordingId}/transcript-search?q=${encodeURIComponent(query)}`)
        .then((result) => setMatchCount(result.count || 0))
        .catch(() => setMatchCount(null));
    }, 250);
    return () => clearTimeout(handle);
  }, [search, recordingId]);

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 92,
    overscan: 6,
  });
  const items = virtualizer.getVirtualItems();
  const startIndex = items[0]?.index ?? -1;
  const endIndex = items[items.length - 1]?.index ?? -1;

  useEffect(() => {
    if (startIndex < 0 || endIndex < startIndex) return;
    const missing: number[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
      if (!cache.current.has(i)) missing.push(i);
    }
    if (missing.length === 0) return;
    const offset = missing[0];
    const limit = missing[missing.length - 1] - offset + 1;
    let cancelled = false;
    apiFetch(`/api/recordings/${recordingId}/utterances?offset=${offset}&limit=${limit}`)
      .then((page) => {
        if (cancelled) return;
        (page.utterances || []).forEach((utterance: Utterance, index: number) => {
          cache.current.set(offset + index, utterance);
        });
        if (cache.current.size > 400) {
          for (const key of cache.current.keys()) {
            if (key < startIndex - 80 || key > endIndex + 80) cache.current.delete(key);
          }
        }
        setRevision((value) => value + 1);
      })
      .catch((err) => setError(err.message || "Could not load transcript lines."));
    return () => { cancelled = true; };
  }, [recordingId, startIndex, endIndex]);

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-20 bg-[#0F1115] pb-4 border-b border-white/5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" size={16} />
          <input
            type="text"
            placeholder="Search keywords in transcript..."
            className="w-full bg-white/5 border border-white/10 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:border-orange-500/50 transition-colors placeholder:text-white/10"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-orange-500 bg-orange-500/10 px-2 py-1 rounded-md">
                {matchCount === null ? "…" : `${matchCount} matches`}
              </div>
              <button type="button" onClick={() => setSearch("")} className="text-white/20 hover:text-white/60">
                <Plus size={14} className="rotate-45" />
              </button>
            </div>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <div ref={parentRef} className="h-[calc(100vh-320px)] min-h-[320px] overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }} data-revision={revision}>
          {items.map((row) => {
            const utterance = cache.current.get(row.index);
            const needle = search.trim().toLowerCase();
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full pb-6"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {!utterance ? (
                  <div className="h-16 rounded-xl bg-white/5 animate-pulse" />
                ) : (
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <User size={14} className="text-orange-500" />
                      <input
                        className="bg-transparent border-none focus:ring-0 text-xs font-bold uppercase tracking-wider p-0 w-32 text-orange-500"
                        value={speakerLabels[utterance.speaker] || `Speaker ${utterance.speaker}`}
                        onChange={(e) => onSpeakerLabel(utterance.speaker, e.target.value)}
                        onBlur={onSaveLabels}
                      />
                      <span className="text-[10px] font-mono opacity-30">{formatClock(utterance.start)}</span>
                    </div>
                    <p
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={async (e) => {
                        const newText = e.currentTarget.innerText;
                        if (newText === utterance.text) return;
                        await apiFetch(`/api/recordings/${recordingId}/utterances/${row.index}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ text: newText }),
                        });
                        cache.current.set(row.index, { ...utterance, text: newText });
                        setRevision((value) => value + 1);
                      }}
                      className="text-lg leading-relaxed text-white/80 font-light outline-none focus:bg-white/5 rounded p-1"
                    >
                      {(utterance.words?.length ? utterance.words : [{ text: utterance.text, start: utterance.start, end: utterance.end, confidence: 1 }]).map((word, wi) => {
                        const active = currentTimeMs >= word.start && currentTimeMs <= word.end;
                        const hit = needle && word.text.toLowerCase().includes(needle);
                        return (
                          <span
                            key={wi}
                            onClick={(e) => {
                              if (e.ctrlKey || e.metaKey) onSeek(word.start / 1000);
                            }}
                            className={`transition-all rounded px-0.5 ${active ? "bg-orange-500 text-white" : hit ? "bg-yellow-500/40 text-white" : "hover:bg-white/10"}`}
                          >
                            {word.text}{" "}
                          </span>
                        );
                      })}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
