import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import { AI_DISCLAIMER } from "./audit";
import {
  MACHINE_LABEL,
  exportFooter,
  formatClock as formatClockHms,
  formatWithZone,
  headerRows,
  reviewStatus,
  type ExportTranscriptRow,
  type ReportExportInput,
} from "./reportExport";
import { speakerDisplayName } from "./speakerNames";
import { parseInlineSpans, parseMarkdownBlocks, type MarkdownBlock } from "./markdownBlocks";
import { sortUnclearAudio } from "./timestamps";

export interface DocxUtterance {
  speaker: string;
  startMs: number;
  text: string;
}

export interface DocxReportInput {
  /** The full case-report description. Preferred. */
  report?: ReportExportInput;
  /** Older fields. Used only when `report` is not given. The audit line is never written to the file. */
  caseName?: string;
  recordingName?: string;
  reportMarkdown?: string;
  officerName?: string;
  officerBadge?: string;
  reportDate?: string;
  auditLine?: string;
  acknowledgement?: string | null;
  utterances?: DocxUtterance[];
  speakerLabels?: Record<string, string>;
}

function toReport(input: DocxReportInput): ReportExportInput {
  if (input.report) return input.report;
  const officer = [input.officerName, input.officerBadge ? `#${input.officerBadge}` : ""].filter(Boolean).join(" ");
  return {
    caseNumber: input.caseName || "",
    examiner: officer || null,
    sourceFileName: input.recordingName || "",
    generatedAt: input.reportDate || null,
    appVersion: "",
    reportId: "NAR-UNSET",
    markdown: input.reportMarkdown || "",
    acknowledgement: input.acknowledgement || null,
    speakerLabels: input.speakerLabels,
    transcript: (input.utterances || []).map((u) => ({ speaker: u.speaker, startMs: u.startMs, text: u.text })),
  };
}

const INK = "1B1B1B";
const ACCENT = "1F3A5F";
const RULE = "CFCFCF";
const SHADE = "F1F1F1";
const CONTENT_WIDTH = 9648; // Letter, 0.9 inch margins, in twips
const thinBorder = { style: BorderStyle.SINGLE, size: 8, color: "222222", space: 6 } as const;

const UNVERIFIED_RX = /(\[\d{1,2}:\d{2}:\d{2} UNVERIFIED\])/g;

function runsFrom(text: string, extras: { bold?: boolean; italics?: boolean; size?: number } = {}): TextRun[] {
  return parseInlineSpans(text).flatMap((span) => String(span.text).split(UNVERIFIED_RX).filter((piece) => piece !== "").map((piece) => {
    const flagged = /^\[\d{1,2}:\d{2}:\d{2} UNVERIFIED\]$/.test(piece);
    return new TextRun({
      text: piece,
      bold: span.bold || extras.bold || flagged,
      italics: span.italics || extras.italics,
      size: extras.size,
      shading: flagged ? { type: ShadingType.CLEAR, color: "auto", fill: "FFE69A" } : undefined,
      // A heavy double outline and bold type, so the marker still stands out on a black-and-white printout.
      border: flagged ? { style: BorderStyle.DOUBLE, size: 12, color: "000000", space: 1 } : undefined,
    });
  }));
}

function headingLevel(level: number) {
  if (level <= 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  return HeadingLevel.HEADING_3;
}

function blockToParagraph(block: MarkdownBlock): Paragraph | null {
  if (block.type === "blank") return new Paragraph({ text: "" });
  if (block.type === "heading") {
    return new Paragraph({
      heading: headingLevel(block.level),
      children: runsFrom(block.text),
    });
  }
  if (block.type === "bullet") {
    return new Paragraph({
      children: runsFrom(block.text),
      bullet: { level: block.level },
    });
  }
  if (block.type === "numbered") {
    return new Paragraph({
      children: runsFrom(block.text),
      numbering: { reference: "report-numbers", level: block.level },
    });
  }
  return new Paragraph({ children: runsFrom(block.text), keepLines: block.text.length <= 700, widowControl: true });
}

const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } as const;
const lightLine = { style: BorderStyle.SINGLE, size: 4, color: "E3E3E3" } as const;

function rule(): Paragraph {
  return new Paragraph({
    spacing: { before: 120, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } },
  });
}

function sectionHeading(text: string, pageBreakBefore = false): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    pageBreakBefore,
    keepNext: true,
    spacing: { before: pageBreakBefore ? 0 : 240, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 2 } },
    children: [new TextRun({ text, bold: true, color: ACCENT })],
  });
}

function headerBlock(report: ReportExportInput): (Paragraph | Table)[] {
  const rows = headerRows(report).map((row) => new TableRow({
    cantSplit: true,
    children: [
      new TableCell({
        width: { size: 2600, type: WidthType.DXA },
        borders: { top: noBorder, left: noBorder, right: noBorder, bottom: lightLine },
        margins: { top: 60, bottom: 60, left: 0, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: row.label, bold: true, color: ACCENT, size: 20 })] })],
      }),
      new TableCell({
        width: { size: CONTENT_WIDTH - 2600, type: WidthType.DXA },
        borders: { top: noBorder, left: noBorder, right: noBorder, bottom: lightLine },
        margins: { top: 60, bottom: 60, left: 0, right: 0 },
        children: [new Paragraph({
          children: [new TextRun({
            text: row.value,
            size: row.mono ? 17 : 20,
            font: row.mono ? "Consolas" : undefined,
          })],
        })],
      }),
    ],
  }));
  const box = { style: BorderStyle.SINGLE, size: 8, color: INK, space: 4 } as const;
  return [
    new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: "Investigative Report", bold: true, size: 40, color: ACCENT })],
    }),
    new Paragraph({
      spacing: { after: 200 },
      children: [new TextRun({ text: "CONFIDENTIAL  \u00B7  LAW ENFORCEMENT USE ONLY", size: 18, color: "444444", characterSpacing: 20 })],
    }),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [2600, CONTENT_WIDTH - 2600],
      rows,
    }),
    new Paragraph({
      spacing: { before: 200, after: 80 },
      border: { top: box, bottom: box, left: box, right: box },
      children: [new TextRun({ text: MACHINE_LABEL, bold: true, size: 21 })],
    }),
    rule(),
  ];
}

function transcriptSection(report: ReportExportInput): (Paragraph | Table)[] {
  const rows: ExportTranscriptRow[] = report.transcript || [];
  if (!rows.length) return [];
  const order = new Map<string, number>();
  const FLAG = /(\[inaudible\]|\[unclear:[^\]]*\])/gi;
  const timeCol = 1300;
  const textCol = CONTENT_WIDTH - timeCol;
  const headCell = (text: string, width: number) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: { top: noBorder, left: noBorder, right: noBorder, bottom: { style: BorderStyle.SINGLE, size: 10, color: INK } },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 17, color: ACCENT, characterSpacing: 10 })] })],
  });
  const head = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: [headCell("Time", timeCol), headCell("Speaker and text", textCol)],
  });
  const gapCount = rows.filter((row) => row.kind === "gap").length;
  const body = rows.map((row) => {
    if (row.kind === "gap") {
      const dashed = { style: BorderStyle.DASHED, size: 6, color: "777777" } as const;
      const gapBorders = { top: dashed, left: noBorder, right: noBorder, bottom: dashed };
      return new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: timeCol, type: WidthType.DXA },
            borders: gapBorders,
            margins: { top: 70, bottom: 70, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: formatClockHms(row.startMs), font: "Consolas", size: 18, color: "333333" })] })],
          }),
          new TableCell({
            width: { size: textCol, type: WidthType.DXA },
            borders: gapBorders,
            margins: { top: 70, bottom: 70, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: row.text, italics: true, bold: true, size: 20 })] })],
          }),
        ],
      });
    }
    if (!order.has(row.speaker)) order.set(row.speaker, order.size);
    const shaded = (order.get(row.speaker) || 0) % 2 === 1;
    const fill = shaded ? { type: ShadingType.CLEAR, color: "auto", fill: SHADE } : undefined;
    const who = speakerDisplayName(row.speaker, report.speakerLabels);
    const pieces = String(row.text || "").split(FLAG);
    const textRuns = pieces.map((piece, index) => (index % 2 === 1
      ? new TextRun({ text: piece, bold: true, shading: { type: ShadingType.CLEAR, color: "auto", fill: "E4E4E4" }, size: 20 })
      : new TextRun({ text: piece, size: 20 })));
    const cellBorders = { top: noBorder, left: noBorder, right: noBorder, bottom: lightLine };
    return new TableRow({
      cantSplit: true,
      children: [
        new TableCell({
          width: { size: timeCol, type: WidthType.DXA },
          shading: fill,
          borders: cellBorders,
          margins: { top: 70, bottom: 70, left: 100, right: 100 },
          verticalAlign: VerticalAlign.TOP,
          children: [new Paragraph({ children: [new TextRun({ text: formatClockHms(row.startMs), font: "Consolas", size: 18, color: "333333" })] })],
        }),
        new TableCell({
          width: { size: textCol, type: WidthType.DXA },
          shading: fill,
          borders: cellBorders,
          margins: { top: 70, bottom: 70, left: 100, right: 100 },
          children: [new Paragraph({ children: [new TextRun({ text: `${who}: `, bold: true, size: 20 }), ...textRuns] })],
        }),
      ],
    });
  });
  return [
    sectionHeading("Transcript", true),
    new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({
        text: "Machine-generated transcript. Passages shown as [inaudible] or [unclear: word] were not recognized with confidence. Verify against the source recording." + (gapCount ? ` ${gapCount} stretch${gapCount === 1 ? "" : "es"} of more than 60 seconds with no transcribed speech ${gapCount === 1 ? "is" : "are"} marked in the table.` : ""),
        size: 19,
        color: "333333",
      })],
    }),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [timeCol, textCol],
      rows: [head, ...body],
    }),
  ];
}

function signoffSection(report: ReportExportInput): (Paragraph | Table)[] {
  const reviewed = !!(report.reviewedBy && report.reviewedAt);
  const line = { style: BorderStyle.SINGLE, size: 6, color: INK } as const;
  const cell = (width: number, typed: string, caption: string) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: { top: noBorder, left: noBorder, right: noBorder, bottom: noBorder },
    margins: { top: 0, bottom: 0, left: 0, right: 160 },
    children: [
      new Paragraph({
        spacing: { before: 360 },
        border: { bottom: line },
        children: [new TextRun({ text: typed || " ", size: 20 })],
      }),
      new Paragraph({ children: [new TextRun({ text: caption, size: 18, color: "333333" })] }),
    ],
  });
  return [
    sectionHeading("Reviewer sign-off"),
    new Paragraph({ spacing: { after: 60 }, keepNext: true, children: [new TextRun({ text: reviewStatus(report), size: 20, color: "333333" })] }),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [4000, 2200, CONTENT_WIDTH - 6200],
      rows: [new TableRow({
        cantSplit: true,
        children: [
          cell(4000, reviewed ? report.reviewedBy || "" : "", "Reviewed by"),
          cell(2200, reviewed ? formatWithZone(report.reviewedAt).slice(0, 10) : "", "Date"),
          cell(CONTENT_WIDTH - 6200, "", "Signature"),
        ],
      })],
    }),
  ];
}

function footerParagraphs(report: ReportExportInput): Paragraph[] {
  const footer = exportFooter(report);
  const small = { size: 15, color: "333333" } as const;
  return [
    new Paragraph({
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 } },
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
      children: [
        new TextRun({ text: footer.left, ...small }),
        new TextRun({ text: "\tPage ", ...small }),
        new TextRun({ children: [PageNumber.CURRENT], ...small }),
        new TextRun({ text: " of ", ...small }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], ...small }),
      ],
    }),
    new Paragraph({ children: [new TextRun({ text: footer.hashLine, font: "Consolas", size: 15, color: "333333" })] }),
  ];
}

export function buildReportDocument(input: DocxReportInput): Document {
  const report = toReport(input);
  const reportParagraphs = parseMarkdownBlocks(sortUnclearAudio(report.markdown || "No summary available."))
    .map(blockToParagraph)
    .filter((p): p is Paragraph => p !== null);

  return new Document({
    creator: "Narrative AI",
    title: `Investigative Report - ${report.caseNumber || "Case"}`,
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22, color: INK }, paragraph: { spacing: { line: 300, after: 100 } } },
        heading1: { run: { font: "Calibri", size: 28, bold: true, color: ACCENT }, paragraph: { spacing: { before: 280, after: 100 } } },
        heading2: { run: { font: "Calibri", size: 26, bold: true, color: ACCENT }, paragraph: { spacing: { before: 240, after: 100 } } },
        heading3: { run: { font: "Calibri", size: 23, bold: true, color: ACCENT }, paragraph: { spacing: { before: 200, after: 80 } } },
      },
    },
    numbering: {
      config: [
        {
          reference: "report-numbers",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
            {
              level: 1,
              format: LevelFormat.LOWER_LETTER,
              text: "%2.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 1440, hanging: 360 } } },
            },
            {
              level: 2,
              format: LevelFormat.LOWER_ROMAN,
              text: "%3.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 2160, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1150, bottom: 1500, left: 1296, right: 1296, footer: 600 },
            pageNumbers: { start: 1 },
          },
        },
        footers: { default: new Footer({ children: footerParagraphs(report) }) },
        children: [
          ...headerBlock(report),
          sectionHeading("Summary"),
          ...reportParagraphs,
          new Paragraph({
            spacing: { before: 240 },
            children: [new TextRun({ text: AI_DISCLAIMER, italics: true, size: 19 })],
          }),
          ...(report.acknowledgement?.trim()
            ? [new Paragraph({ children: [new TextRun({ text: report.acknowledgement.trim(), size: 19, color: "333333" })] })]
            : []),
          ...transcriptSection(report),
          new Paragraph({ spacing: { before: 200 }, children: [] }),
          ...signoffSection(report),
        ],
      },
    ],
  });
}
export async function reportToDocxBlob(input: DocxReportInput): Promise<Blob> {
  return Packer.toBlob(buildReportDocument(input));
}
