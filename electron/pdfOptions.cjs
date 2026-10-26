// Shared PDF print settings for the app (main.js) and the test/sample script.
// Chromium 126 has no CSS page-margin boxes, so "Page X of Y" comes from the footer template.

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MARGINS = { top: 0.8, bottom: 1.25, left: 0.9, right: 0.9 };

/**
 * footer: { left, hashLine } is shown on every page with "Page X of Y".
 * Only case number, report ID, app version and the source hash belong here.
 */
function buildPdfOptions(footer) {
  const left = escapeHtml((footer && footer.left) || "");
  const hashLine = escapeHtml((footer && footer.hashLine) || "");
  const footerTemplate = `<div style="width:100%;box-sizing:border-box;padding:0 ${MARGINS.left}in;padding-bottom:0.5in;font-family:'Segoe UI',Arial,sans-serif;font-size:8pt;color:#333;-webkit-print-color-adjust:exact;">
      <div style="border-top:1px solid #cfcfcf;padding-top:4px;display:flex;justify-content:space-between;">
        <span>${left}</span>
        <span style="white-space:nowrap;margin-left:12px;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
      <div style="font-family:Consolas,'Courier New',monospace;font-size:8pt;color:#333;margin-top:2px;word-break:break-all;">${hashLine}</div>
    </div>`;
  return {
    printBackground: true,
    pageSize: "Letter",
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate,
    margins: MARGINS,
  };
}

module.exports = { buildPdfOptions, escapeHtml, MARGINS };