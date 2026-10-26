// Renders the case report from SYNTHETIC data only: HTML, PDF and DOCX. Used for visual checks and the sample.
// Usage: node --import tsx scripts/render-sample-report.ts <outDir> [reviewed] [longcase]
//   reviewed  - shows the report after a person confirmed the review
//   unverified - adds one deliberately wrong (synthetic) time so the UNVERIFIED marker can be checked in print
//   longcase  - uses a very long case number, to check that the PDF footer never clips
//
// The transcript is a long interview with distinct lines (no repeated filler). The summary is built from
// the transcript itself: every cited time is the start time of the line that holds the quoted words, and
// the script stops if the timestamp check finds anything it cannot verify.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { Packer } from "docx";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

const { buildPrintableReportHtml } = await import("../src/services/reportHtml.ts");
const { buildReportDocument } = await import("../src/services/reportDocx.ts");
const { exportFooter, makeReportId } = await import("../src/services/reportExport.ts");
const { APP_VERSION } = await import("../src/version.ts");
const { segmentUtterances, verifyTimestamps, findGaps, gapLabel, clock, normalizeForMatch } = await import("../src/services/timestamps.ts");

const outDir = path.resolve(process.argv[2] || "sample-out");
const flags = process.argv.slice(3);
const reviewed = flags.includes("reviewed");
const longCase = flags.includes("longcase");
// "unverified": adds one deliberately wrong cited time (inside the silent stretch) to show how an UNVERIFIED marker prints.
const unverifiedDemo = flags.includes("unverified");
fs.mkdirSync(outDir, { recursive: true });

// A = detective, B = witness. Each line is spoken once; no line repeats.
const lines: [string, string][] = [
  ["A", "This is Detective Alvarez. Today is October 12th, it's about two in the afternoon, and I'm at the station with Jordan Ellis. Jordan, you understand this is being recorded?"],
  ["B", "Yes, I understand."],
  ["A", "Thanks for coming in. Tell me what you remember about the evening of October 9th."],
  ["B", "I was in my living room watching TV when I heard a loud crack, like glass. I looked at my phone and it was about nine-forty."],
  ["A", "What did you do when you heard it?"],
  ["B", "I went to the front window. There was one person standing next to a gray sedan across the street."],
  ["A", "Can you describe the person?"],
  ["B", "Average height, dark hooded sweatshirt. I couldn't see the face because of the hood and, you know, the distance."],
  ["A", "Was the street lit at that hour?"],
  ["B", "There's one streetlight at the corner, but the light is on the far side of the sedan, so most of what I saw was a shape."],
  ["A", "Did you see anything in the person's hands?"],
  ["B", "I didn't see anything in his hands, but it was dark."],
  ["A", "How far is your window from where the sedan was parked?"],
  ["B", "Maybe sixty feet. I'm on the second floor of the duplex, so I was looking down a little."],
  ["A", "Which way did the person go?"],
  ["B", "He walked toward [unclear: Fifth] Avenue. I lost sight of him near the corner."],
  ["A", "How long did you watch?"],
  ["B", "Maybe a minute. Then a truck went by and [inaudible] and when it passed he was gone."],
  ["A", "Was the person walking or running?"],
  ["B", "Walking. Not fast, not slow. Like someone who didn't want to be noticed."],
  ["A", "Did you hear a car door or an engine?"],
  ["B", "No engine. I heard the glass first and then maybe a door, but I can't swear to the door."],
  ["A", "Did anyone else come outside?"],
  ["B", "Not that I saw. The Hendersons next door have a dog and it barked for a few seconds, then stopped."],
  ["A", "What time did you notice the dog?"],
  ["B", "Right after the glass. Within a minute, I'd say."],
  ["A", "Let's go back to the person. Any logo or writing on the sweatshirt?"],
  ["B", "I didn't see one. It was plain, dark gray or black. The hood was up the whole time."],
  ["A", "What about shoes or pants?"],
  ["B", "Dark pants. Shoes, I couldn't tell you. The car was between us."],
  ["A", "Did the person carry a bag or a backpack?"],
  ["B", "I don't think so. Both arms were swinging when he walked away."],
  ["A", "Let me step out for a moment and pull up the map. I'll be right back."],
  ["B", "Sure, no problem."],
  ["A", "Okay, I'm back. I have the block map in front of me. Can you show me where the sedan was parked?"],
  ["B", "It was here, in front of the green mailbox, facing north. The driver's side was toward my house."],
  ["A", "And the person was on which side of the car?"],
  ["B", "The driver's side. Right at the window. That's where I saw the glass on the ground the next morning."],
  ["A", "Did you touch anything on the sedan?"],
  ["B", "No. I only looked at it from the sidewalk. I took one photo of the broken window on my phone."],
  ["A", "Do you still have that photo?"],
  ["B", "Yes. I can send it to you. It has the date on it, October 10th, a little after seven in the morning."],
  ["A", "Please do. Now, you mentioned you didn't call the police that night. Why was that?"],
  ["B", "I wasn't sure it was a break-in. I thought maybe a bottle fell out of a recycling bin. In the morning I saw broken glass next to the car and called the non-emergency line."],
  ["A", "Do you remember who you spoke with on the non-emergency line?"],
  ["B", "A dispatcher. She gave me a reference number, but I wrote it on a receipt and I'm not sure where it went."],
  ["A", "That's all right, we can look it up by the time of the call. Did you speak with the car's owner?"],
  ["B", "I don't know them. I left a note on the windshield with my number."],
  ["A", "Has anyone contacted you since?"],
  ["B", "Not about the note. Just you."],
  ["A", "Have you seen this person or this sedan on your street before?"],
  ["B", "The sedan, maybe once or twice. I think it belongs to someone who visits the house on the corner. The person, no. I wouldn't know them if I saw them."],
  ["A", "Do you have any cameras at your house?"],
  ["B", "A doorbell camera, but it faces my own porch. It might catch the edge of the street, I'm not sure."],
  ["A", "Is the doorbell camera set to save video?"],
  ["B", "It saves clips when it sees motion. I get a notification on my phone. I didn't get one that night, but I'd have to check the history."],
  ["A", "Would you be willing to check that history and send us anything from October 9th?"],
  ["B", "Yes, absolutely. I can do it tonight."],
  ["A", "Does anyone else live at your address?"],
  ["B", "My sister lives downstairs. She was at work that night, she works the evening shift at the hospital."],
  ["A", "Did you talk with your sister about what you saw?"],
  ["B", "I told her the next morning. She said I should call someone, so that's when I called."],
  ["A", "Did you talk to any other neighbors about it?"],
  ["B", "Mr. Henderson asked me on Sunday if I'd heard anything. I told him I heard glass. That was the whole conversation."],
  ["A", "Did Mr. Henderson say whether he saw anything?"],
  ["B", "He said he was asleep. He said the dog woke him up, but by the time he looked out nobody was there."],
  ["A", "Let's talk about the glass. How much glass did you see in the morning?"],
  ["B", "A lot, all along the curb under the driver's window. Some was in small pieces, like the safety kind."],
  ["A", "Was anything on the ground other than glass?"],
  ["B", "A crushed paper cup near the rear tire. I don't know if it was there before."],
  ["A", "Did you pick up the cup or move anything?"],
  ["B", "No. I figured somebody might want to look at it."],
  ["A", "That was a good call. Is there anything else you noticed about the sedan itself?"],
  ["B", "The back seat had a gray blanket over something. I only noticed it because the window was broken and the blanket was moved."],
  ["A", "Moved how?"],
  ["B", "Pulled to one side, like someone had reached in and tugged it. That's the only way I can describe it."],
  ["A", "Do you remember the license plate?"],
  ["B", "No. It's a state plate, white with a blue band, but I never read it. I'm sorry."],
  ["A", "You don't need to apologize. Is the sedan still parked there?"],
  ["B", "It was gone by Sunday afternoon. I didn't see it leave."],
  ["A", "Did the owner ever respond to your note?"],
  ["B", "No, and that's part of why I decided to come in when you called."],
  ["A", "When did the person walk past the second streetlight, if at all?"],
  ["B", "I don't think he made it that far in my view. The corner building blocks everything past the mailbox."],
  ["A", "So your view ends at the corner."],
  ["B", "Right. After that I only know what I could hear, which was nothing."],
  ["A", "Did you hear a vehicle start up anywhere on the block after the person left?"],
  ["B", "Not on our block. There was a car further away, maybe a few streets over, but cars go by all night there."],
  ["A", "Thank you. I want to read back what I have so you can correct anything. You heard glass at about nine-forty, saw one person at a gray sedan, and the person walked toward Fifth Avenue."],
  ["B", "That's right. And I'd add that the person never looked up at my window, as far as I could tell."],
  ["A", "Anything else you'd like to add that I haven't asked about?"],
  ["B", "Just that I wish I'd called that night. I keep thinking if I'd called, somebody could have come out while the person was still on the block. At the time I told myself it was nothing, because things like that are usually nothing, and then in the morning I saw the glass and the broken window and I felt bad. I looked at the time on my phone, I remember that clearly, and I remember the dog barking, and I remember the truck. The truck is the only reason I lost sight of the person. When it passed, the sidewalk was empty."],
  ["A", "I appreciate that. You did the right thing by coming in. Is there anyone else you think we should talk to?"],
  ["B", "Maybe the person at the corner house, the one who owns the sedan or whose visitor owns it. I don't know the name."],
  ["A", "We'll follow up with the owner records. Do you have any questions for me?"],
  ["B", "Will I need to come back or testify?"],
  ["A", "I can't say. For now, we only need your account and the photo and any video you find. If anything changes, I'll call you."],
  ["B", "Okay. I'll send the photo and the doorbell history tonight."],
  ["A", "Thank you for your time, Jordan. The time is now about two thirty-five and we are ending the interview."],
  ["B", "Thank you, Detective."],
];

// Gaps (milliseconds of silence) after these line indexes. Both exceed 60 seconds.
const silenceAfter = new Map<number, number>([[32, 95_000], [78, 72_000]]);

// Timing: a plausible speaking pace, then a short pause. Every utterance carries word times.
const utterances: any[] = [];
let clockMs = 6000;
lines.forEach(([speaker, text], i) => {
  const tokens = text.split(/\s+/);
  const wordMs = 390 + ((text.length + i) % 5) * 15;
  const start = clockMs;
  const words = tokens.map((token, k) => ({
    text: token,
    start: start + k * wordMs,
    end: start + (k + 1) * wordMs - 40,
    confidence: /^\[unclear:/.test(token) || /^(Fifth\])$/.test(token) ? 0.2 : 0.95,
    speaker,
  }));
  const end = start + tokens.length * wordMs;
  utterances.push({ speaker, start, end, text, words });
  clockMs = end + 1400 + ((i * 7) % 5) * 300 + (silenceAfter.get(i) || 0);
});
const durationMs = clockMs + 4000;

const segments = segmentUtterances(utterances);
const rows: any[] = segments.map((s) => ({ speaker: s.speaker, startMs: s.startMs, text: s.text }));
const gaps = findGaps(segments, { minMs: 60_000, durationMs });
for (const gap of gaps) rows.push({ speaker: "", startMs: gap.fromMs, endMs: gap.toMs, kind: "gap", text: gapLabel(gap) });
rows.sort((a, b) => a.startMs - b.startMs);

// --- The summary is written from the transcript: times come from the line that holds the words. ---
const seg = (phrase: string) => {
  const want = normalizeForMatch(phrase);
  const found = segments.find((s) => normalizeForMatch(s.text).includes(want));
  if (!found) throw new Error(`Sample phrase not in the transcript: ${phrase}`);
  return found;
};
const T = (phrase: string) => `[${clock(seg(phrase).startMs)}]`;
const Q = (phrase: string) => { seg(phrase); return `"${phrase}"`; };

const markdown = `## 1. Case Information
- **Case:** 26-104417 (synthetic sample)
- **Recording:** sample-interview-room-2.m4a
- **Recording Date:** 2026-10-12
- **Report Type:** Witness Interview
- **Participants:** Det. R. Alvarez; Jordan Ellis (witness)

## 2. Executive Summary
Det. R. Alvarez interviewed Jordan Ellis about a reported vehicle break-in on the 1400 block of Maple Street on the evening of October 9. Ellis stated that they heard glass breaking at about 9:40 PM, looked out of a second-floor front window, and saw one person near a gray sedan. The witness said the face was not visible and no weapon was seen. The witness stated that the person walked toward Fifth Avenue. They agreed to send a photo of the damage and any doorbell camera video from October 9.

## 3. Officer Narrative (Detailed Chronological Account)
At ${T("This is Detective Alvarez")} Det. Alvarez stated the date, time and location of the interview and asked Ellis to confirm that the interview was being recorded. At ${T("Yes, I understand.")} the witness stated, ${Q("Yes, I understand.")}

At ${T("Tell me what you remember about the evening of October 9th")} the detective asked the witness what they remembered about the evening of October 9. The witness stated that they were watching television when they heard ${Q("a loud crack, like glass")} ${T("a loud crack, like glass")} and that the time was about nine-forty.

At ${T("Average height, dark hooded sweatshirt")} the witness described the person as ${Q("Average height, dark hooded sweatshirt")}. They said the face could not be seen because of the hood and the distance.

At ${T("I didn't see anything in his hands")} the detective asked whether the witness saw anything in the person's hands. The witness stated, ${Q("I didn't see anything in his hands, but it was dark.")}

At ${T("Maybe sixty feet")} the witness stated that the window is ${Q("Maybe sixty feet")} from where the sedan was parked and that they were looking down from the second floor.

At ${T("I lost sight of him near the corner")} the witness stated that the person walked toward Fifth Avenue and that they ${Q("lost sight of him near the corner")}. They attributed the lost view to a passing truck at ${T("a truck went by")}.

At ${T("Walking. Not fast, not slow")} the witness stated that the person was ${Q("Walking. Not fast, not slow.")}

At ${T("The Hendersons next door have a dog")} the witness stated that a neighbor's dog barked for a few seconds after the glass broke.

${unverifiedDemo ? "At [00:04:50] the witness described the color of the sedan as dark gray.\n\n" : ""}At ${T("I took one photo of the broken window")} the witness stated that they took one photo of the broken window, and at ${T("It has the date on it, October 10th")} said the photo is dated October 10th. They agreed to send it.

At ${T("I wasn't sure it was a break-in")} the witness stated that they did not call the police that night because ${Q("I wasn't sure it was a break-in")}. They said they saw broken glass beside the sedan the next morning and called the non-emergency line.

At ${T("A doorbell camera, but it faces my own porch")} the witness stated that they have a doorbell camera that faces the porch and may show the edge of the street. They agreed at ${T("I can do it tonight")} to check the history that night.

At ${T("A crushed paper cup near the rear tire")} the witness stated that they saw a crushed paper cup near the rear tire and did not move it.

At ${T("Pulled to one side, like someone had reached in")} the witness stated that a blanket on the back seat appeared to have been ${Q("Pulled to one side, like someone had reached in and tugged it")}.

At ${T("Just that I wish I'd called that night")} the witness added a longer statement about not calling that night and about the sequence of the dog, the truck and the empty sidewalk. The statement continues at ${T("The truck is the only reason I lost sight of the person")}.

## 4. Key Statements
- **${T("Average height, dark hooded sweatshirt")} Ellis:** ${Q("Average height, dark hooded sweatshirt.")}
- **${T("I didn't see anything in his hands")} Ellis:** ${Q("I didn't see anything in his hands, but it was dark.")}
- **${T("I wasn't sure it was a break-in")} Ellis:** ${Q("I wasn't sure it was a break-in.")}
- **${T("The truck is the only reason I lost sight of the person")} Ellis:** ${Q("The truck is the only reason I lost sight of the person.")}

## 5. Unclear Audio
- ${T("and when it passed he was gone")} A short passage was marked [inaudible] while a truck passed.
- ${T("He walked toward")} The street name was marked as unclear in the transcript.

## 6. Follow-Up Items
- Obtain any doorbell or street camera video for the 1400 block of Maple Street for the evening of October 9.
- Obtain the photo dated October 10 that Ellis agreed to send.
- Look up the non-emergency call by time, because Ellis did not keep the reference number.
- Identify the owner of the gray sedan from the owner records.
`;

const check = verifyTimestamps(markdown, segments);
if (unverifiedDemo ? (check.unverified !== 1 || check.corrected) : (check.unverified || check.corrected)) {
  throw new Error(`Sample timestamps do not match the transcript: ${JSON.stringify(check.flagged)} ${JSON.stringify(check.changes)}`);
}
console.log(`Timestamp check: ${check.cited} cited, ${check.verified} verified, ${check.corrected} corrected, ${check.unverified} unverified`);
console.log(`Transcript: ${segments.length} segments, ${gaps.length} gaps (${gaps.map(gapLabel).join("; ")}), length ${clock(durationMs)}`);

const generatedAt = "2026-10-12T14:31:00-05:00";
const sourceSha256 = "9f2c41d8a7b63e5f01c4d89a2b7e6f3c5a1d0e9b8c7f6a5d4e3b2c1a0f9e8d7c";
const reportId = await makeReportId(["sample", generatedAt, sourceSha256]);
const report = {
  caseNumber: longCase ? "2026-CR-00104417-DET-ALVAREZ-0001-SUPPLEMENTAL" : "26-104417",
  examiner: "Det. R. Alvarez #4412",
  sourceFileName: "sample-interview-room-2.m4a",
  importedAt: "2026-10-12T14:02:00-05:00",
  durationMs,
  sourceSha256,
  generatedAt,
  service: "AssemblyAI",
  model: "claude-sonnet-4-6",
  transcriptionService: "AssemblyAI",
  timestampCheck: { cited: check.cited, verified: check.verified, corrected: check.corrected, unverified: check.unverified },
  appVersion: APP_VERSION,
  reportId,
  reportType: "Witness Interview",
  markdown: check.text,
  transcript: rows,
  speakerLabels: { A: "Det. R. Alvarez", B: "Jordan Ellis (witness)" },
  reviewedBy: reviewed ? "Sgt. M. Parker" : null,
  reviewedAt: reviewed ? "2026-10-13T09:15:00-05:00" : null,
  acknowledgement: "AI use acknowledged by user on Oct 12, 2026 2:30 PM CDT.",
};

const html = buildPrintableReportHtml({ report });
const htmlPath = path.join(outDir, "sample-report.html");
const footerPath = path.join(outDir, "footer.json");
const pdfPath = path.join(outDir, "sample-report.pdf");
fs.writeFileSync(htmlPath, html, "utf8");
fs.writeFileSync(footerPath, JSON.stringify(exportFooter(report)), "utf8");
const electron = path.join(process.cwd(), "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
execFileSync(electron, [path.join(process.cwd(), "scripts", "pdf-from-html.cjs"), htmlPath, pdfPath, footerPath], {
  env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" },
  timeout: 120000,
});
fs.writeFileSync(path.join(outDir, "sample-report.docx"), await Packer.toBuffer(buildReportDocument({ report })));
fs.writeFileSync(path.join(outDir, "transcript-rows.json"), JSON.stringify(rows.map((r) => ({ t: clock(r.startMs), speaker: r.speaker, text: r.text, kind: r.kind || "" })), null, 1), "utf8");
console.log(`Wrote ${pdfPath}`);