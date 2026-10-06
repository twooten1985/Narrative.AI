import { useEffect } from "react";
import { formatAiAcknowledgement } from "../services/audit";

export interface SessionAcknowledgement {
  iso: string;
  label: string;
}

export function AiAcknowledgementModal({
  onAcknowledge,
}: {
  onAcknowledge: (ack: SessionAcknowledgement) => void;
}) {
  useEffect(() => {
    const block = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-ack-title"
      data-testid="ai-ack-modal"
    >
      <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#16191E] p-8 shadow-2xl">
        <p className="text-[10px] font-bold uppercase tracking-widest text-orange-500">Before you continue</p>
        <h2 id="ai-ack-title" className="mt-2 text-2xl font-bold">This program uses AI</h2>
        <p className="mt-4 text-sm leading-relaxed text-white/70">
          Narrative AI uses artificial intelligence to transcribe recordings and write reports. AI can make mistakes, including wrong words, wrong speaker names, and missing facts.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-white/70">
          By continuing, you agree to perform due diligence and check every report against the original recording before you rely on it.
        </p>
        <button
          type="button"
          data-testid="ai-ack-button"
          className="mt-6 w-full rounded-xl bg-orange-500 py-3 text-sm font-bold text-white hover:bg-orange-600"
          onClick={() => {
            const iso = new Date().toISOString();
            onAcknowledge({ iso, label: formatAiAcknowledgement(iso) });
          }}
        >
          I Acknowledge
        </button>
        <p className="mt-3 text-[11px] leading-relaxed text-white/35">
          This is recorded for this session and saved with each report you generate. Closing the application exits without using the app.
        </p>
      </div>
    </div>
  );
}
