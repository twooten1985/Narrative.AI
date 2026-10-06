import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} from "docx";
import { AI_DISCLAIMER } from "./audit";
import { speakerDisplayName } from "./speakerNames";
import { parseInlineSpans, parseMarkdownBlocks, type MarkdownBlock } from "./markdownBlocks";

export interface DocxUtterance {
  speaker: string;
  startMs: number;
  text: string;
}

export interface DocxReportInput {
  caseName: string;
  recordingName: string;
  reportMarkdown: string;
  officerName?: string;
  officerBadge?: string;
  reportDate: string;
  auditLine: string;
  acknowledgement?: string | null;
  utterances?: DocxUtterance[];
  speakerLabels?: Record<string, string>;
}

const thinBorder = { style: BorderStyle.SINGLE, size: 8, color: "222222", space: 6 } as const;

function runsFrom(text: string, extras: { bold?: boolean; italics?: boolean; size?: number } = {}): TextRun[] {
  return parseInlineSpans(text).map((span) => new TextRun({
    text: span.text,
    bold: span.bold || extras.bold,
    italics: span.italics || extras.italics,
    size: extras.size,
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
  return new Paragraph({ children: runsFrom(block.text) });
}

function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function headerLine(input: DocxReportInput): string {
  const officer = [input.officerName, input.officerBadge ? `#${input.officerBadge}` : ""]
    .filter(Boolean)
    .join(" ");
  return [`Case: ${input.caseName || "Untitled case"}`, officer, input.reportDate].filter(Boolean).join("   |   ");
}

export function buildReportDocument(input: DocxReportInput): Document {
  const reportParagraphs = parseMarkdownBlocks(input.reportMarkdown)
    .map(blockToParagraph)
    .filter((p): p is Paragraph => p !== null);

  const transcriptParagraphs: Paragraph[] = [];
  if (input.utterances && input.utterances.length > 0) {
    transcriptParagraphs.push(new Paragraph({ text: "" }));
    transcriptParagraphs.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      text: "Transcript",
    }));
    for (const utterance of input.utterances) {
      const who = speakerDisplayName(utterance.speaker, input.speakerLabels);
      transcriptParagraphs.push(new Paragraph({
        children: [new TextRun({ text: `${who} (${formatClock(utterance.startMs)}):`, bold: true })],
      }));
      transcriptParagraphs.push(new Paragraph({ children: runsFrom(utterance.text || "") }));
      transcriptParagraphs.push(new Paragraph({ text: "" }));
    }
  }

  return new Document({
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
            margin: { top: 1008, bottom: 1008, left: 1008, right: 1008 },
            pageNumbers: { start: 1 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                border: { bottom: thinBorder },
                children: [new TextRun({ text: headerLine(input), bold: true, size: 18 })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                border: { top: thinBorder },
                children: [new TextRun({ text: AI_DISCLAIMER, italics: true, size: 16 })],
              }),
              ...(input.acknowledgement?.trim()
                ? [new Paragraph({
                    children: [new TextRun({ text: input.acknowledgement.trim(), size: 14, color: "444444" })],
                  })]
                : []),
              new Paragraph({
                children: [new TextRun({ text: input.auditLine, size: 14, color: "444444" })],
              }),
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: "Page ", size: 14 }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 14 }),
                  new TextRun({ text: " of ", size: 14 }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14 }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "OFFICIAL INVESTIGATIVE REPORT", bold: true })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: input.recordingName || "", italics: true, size: 20 })],
          }),
          new Paragraph({ text: "" }),
          ...reportParagraphs,
          new Paragraph({ text: "" }),
          new Paragraph({
            children: [new TextRun({ text: AI_DISCLAIMER, italics: true })],
          }),
          ...(input.acknowledgement?.trim()
            ? [new Paragraph({
                children: [new TextRun({ text: input.acknowledgement.trim(), italics: true, size: 18 })],
              })]
            : []),
          new Paragraph({
            children: [new TextRun({ text: input.auditLine, size: 18, color: "444444" })],
          }),
          ...transcriptParagraphs,
        ],
      },
    ],
  });
}

export async function reportToDocxBlob(input: DocxReportInput): Promise<Blob> {
  return Packer.toBlob(buildReportDocument(input));
}
