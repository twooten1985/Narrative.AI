import React, { useEffect, useMemo, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { AI_DISCLAIMER, formatAuditLine, type AuditFields } from "../services/audit";
import { renderReportHtml } from "../services/reportHtml";
import { TRUNCATION_WARNING } from "../services/reportPipeline";

function highlightInElement(root: HTMLElement, query: string) {
  const needle = query.trim();
  if (!needle) return;
  const flags = "gi";
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  for (const node of nodes) {
    const text = node.nodeValue || "";
    if (!text.toLowerCase().includes(needle.toLowerCase())) continue;
    const regex = new RegExp(escaped, flags);
    const frag = document.createDocumentFragment();
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const mark = document.createElement("mark");
      mark.className = "bg-orange-500 text-white rounded-sm px-0.5";
      mark.textContent = match[0];
      frag.appendChild(mark);
      last = match.index + match[0].length;
      if (match.index === regex.lastIndex) regex.lastIndex += 1;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}

export function SafeReport({ markdown, filter }: { markdown: string; filter?: string }) {
  const html = useMemo(() => renderReportHtml(markdown), [markdown]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html;
    if (filter?.trim()) highlightInElement(el, filter);
  }, [html, filter]);

  return <div ref={ref} className="report-html" />;
}

export function ReportAuditFooter({ meta }: { meta?: AuditFields | null }) {
  return (
    <div className="report-footer">
      <p className="font-semibold">{AI_DISCLAIMER}</p>
      {meta?.aiAcknowledgedLabel?.trim() && (
        <p className="mt-1" data-testid="ai-ack-footer">{meta.aiAcknowledgedLabel}</p>
      )}
      <p className="mt-1 font-mono text-[11px] opacity-80">{formatAuditLine(meta || {})}</p>
    </div>
  );
}

export function ReportBody({
  markdown,
  filter,
  meta,
  truncated,
  onContinue,
  continuing,
}: {
  markdown: string;
  filter?: string;
  meta?: AuditFields | null;
  truncated?: boolean;
  onContinue?: () => void;
  continuing?: boolean;
}) {
  const showWarning = truncated || (markdown || "").includes("reached the model's length limit");
  return (
    <div className="space-y-4">
      {showWarning && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100">
          <AlertTriangle className="mt-0.5 shrink-0 text-amber-400" size={18} />
          <div className="space-y-2">
            <p className="text-sm font-bold">This report was cut short</p>
            <p className="text-xs leading-relaxed text-amber-100/80">
              {TRUNCATION_WARNING.replace(/^>\s*\*\*Warning:\*\*\s*/, "")}
            </p>
            {onContinue && (
              <button
                type="button"
                onClick={onContinue}
                disabled={continuing}
                className="px-3 py-1.5 rounded-lg bg-amber-400 text-black text-xs font-bold disabled:opacity-50"
              >
                {continuing ? "Continuing…" : "Continue / regenerate remaining"}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="prose prose-invert prose-orange max-w-none rounded-2xl border border-white/10 bg-white/5 p-8 text-sm leading-relaxed">
        <SafeReport markdown={markdown} filter={filter} />
      </div>
      <ReportAuditFooter meta={meta} />
    </div>
  );
}
