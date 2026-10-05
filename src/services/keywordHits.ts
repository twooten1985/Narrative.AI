export interface KeywordHit {
  keyword: string;
  context: string;
  start: string;
  confidence: number;
}

function formatTime(ms: number): string {
  const seconds = Math.floor((ms || 0) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Find keyword windows in a word list. The caller should drop the word list afterward. */
export function keywordHits(
  words: { text?: string; start?: number; confidence?: number }[] | null | undefined,
  keywords: string[],
  windowSize = 10
): KeywordHit[] {
  const wanted = new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0 || !words) return [];
  const hits: KeywordHit[] = [];
  words.forEach((word, index) => {
    const raw = String(word.text || "");
    const token = raw.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, "");
    if (!wanted.has(token) && !wanted.has(raw.toLowerCase())) return;
    const startIdx = Math.max(0, index - windowSize);
    const endIdx = Math.min(words.length, index + windowSize + 1);
    hits.push({
      keyword: raw,
      context: words.slice(startIdx, endIdx).map((w) => w.text).join(" "),
      start: formatTime(word.start || 0),
      confidence: word.confidence || 0,
    });
  });
  return hits;
}
