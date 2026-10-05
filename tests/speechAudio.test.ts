import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SPEECH_AUDIO_BITRATE,
  SPEECH_AUDIO_CHANNELS,
  assertSpeechUploadTarget,
  isConvertedSpeechFile,
  needsSpeechConversion,
  uploadTargetIsSpeechAudio,
} from "../src/services/speechAudio.ts";

describe("speech conversion target", () => {
  it("converts video and wav, and leaves compressed audio alone", () => {
    assert.equal(needsSpeechConversion({ filename: "clip.mp4", mimeType: "video/mp4" }), true);
    assert.equal(needsSpeechConversion({ filename: "clip.wav", mimeType: "audio/wav", originalName: "Interview.WAV" }), true);
    assert.equal(needsSpeechConversion({ filename: "uuid.mov", originalName: "door.MOV" }), true);
    assert.equal(needsSpeechConversion({ filename: "call.mp3", mimeType: "audio/mpeg" }), false);
    assert.equal(needsSpeechConversion({ filename: "call.m4a", mimeType: "audio/mp4" }), false);
    assert.equal(SPEECH_AUDIO_BITRATE, "96k");
    assert.equal(SPEECH_AUDIO_CHANNELS, 1);
  });

  it("refuses to upload the original video and accepts the converted mp3", () => {
    assert.equal(isConvertedSpeechFile("a.mp4", "b.mp3"), true);
    assert.equal(isConvertedSpeechFile("a.mp4", "a.mp4"), false);
    assert.equal(uploadTargetIsSpeechAudio({ filename: "a.mp4", mimeType: "video/mp4" }, "b.mp3"), true);
    assert.equal(uploadTargetIsSpeechAudio({ filename: "a.mp3", mimeType: "audio/mpeg" }, "a.mp3"), true);
    assert.throws(
      () => assertSpeechUploadTarget({ filename: "a.mp4", mimeType: "video/mp4", originalName: "interview.mp4" }, "a.mp4"),
      /Refusing to upload the original video or WAV/,
    );
  });
});
