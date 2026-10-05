import path from "path";

/**
 * Speech MP3 used for the AssemblyAI upload and as the playback fallback when
 * the original file is video or WAV.
 *
 * 96 kbps mono is about 43 MB per hour. That is small enough to finish on a
 * slow mobile uplink, and it stays intelligible when an officer listens to the
 * converted file. 64 kbps would be smaller, but this same file is what plays
 * back in the case view, so 96 kbps stays closer to a normal speech MP3.
 * The source sample rate is left unchanged; AssemblyAI resamples for the model.
 */
export const SPEECH_AUDIO_BITRATE = "96k";
export const SPEECH_AUDIO_CHANNELS = 1;

const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".mpg", ".mpeg", ".avi", ".mkv", ".wmv", ".webm", ".3gp", ".ts", ".m2ts",
]);

export interface SpeechSource {
  filename: string;
  mimeType?: string | null;
  originalName?: string | null;
}

function extensionOf(name: string | null | undefined): string {
  return path.extname(name || "").toLowerCase();
}

/** Video and WAV are converted before upload. Other audio (mp3, m4a, …) is uploaded as stored. */
export function needsSpeechConversion(source: SpeechSource): boolean {
  const mime = (source.mimeType || "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  if (mime === "audio/wav" || mime === "audio/x-wav" || mime === "audio/wave" || mime === "audio/vnd.wave") return true;
  const ext = extensionOf(source.originalName) || extensionOf(source.filename);
  const fileExt = extensionOf(source.filename);
  if (ext === ".wav" || fileExt === ".wav") return true;
  return VIDEO_EXT.has(ext) || VIDEO_EXT.has(fileExt);
}

/** True when the stored transcription file is a converted MP3, not the original video/WAV. */
export function isConvertedSpeechFile(originalFilename: string, transcriptionFilename: string | null | undefined): boolean {
  if (!transcriptionFilename) return false;
  if (transcriptionFilename === originalFilename) return false;
  return extensionOf(transcriptionFilename) === ".mp3";
}

export function uploadTargetIsSpeechAudio(source: SpeechSource, uploadFilename: string): boolean {
  if (!needsSpeechConversion(source)) return true;
  return isConvertedSpeechFile(source.filename, uploadFilename);
}

export function assertSpeechUploadTarget(source: SpeechSource, uploadFilename: string): void {
  if (uploadTargetIsSpeechAudio(source, uploadFilename)) return;
  throw new Error("Refusing to upload the original video or WAV. The converted speech MP3 is not ready.");
}
