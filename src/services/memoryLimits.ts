// Limits that actually apply to Electron 31 (Chromium 126, Node 20, V8 12.6)
// with pointer compression and the V8 sandbox turned on. Raising flags past
// these does not make a bigger allocation succeed.

/** One JS string cannot exceed this. JSON.parse of a bigger transcript throws. */
export const V8_STRING_MAX_BYTES = (1 << 29) - 24; // 536,870,888 (~512 MiB)

/** One ArrayBuffer / Buffer. Larger reads throw "Invalid array buffer length". */
export const V8_ARRAY_BUFFER_MAX_BYTES = 2 * 1024 * 1024 * 1024 - 2 * 64 * 1024;

/** Pointer-compression cage. --max-old-space-size above this is ignored. */
export const V8_HEAP_CAGE_MB = 4096;

/**
 * Chromium mojo / Electron IPC rejects a single message around 128 MiB.
 * File bytes go by path, never through ipcRenderer or express JSON.
 */
export const ELECTRON_IPC_SAFE_BYTES = 64 * 1024 * 1024;

/** Heap size requested for the main process, the server, and the renderer. */
export const PROCESS_HEAP_MB = V8_HEAP_CAGE_MB;

/**
 * JSON bodies are settings, ids, and short edits. Transcripts stay in SQLite
 * and are paged out. 2 MB is enough for those requests and rejects a full
 * word-level transcript if something tries to post one.
 */
export const JSON_BODY_LIMIT = "2mb";

/** Local Whisper reads one segment, then deletes it. 10 min of 16 kHz mono s16 is ~19 MB. */
export const WHISPER_SEGMENT_MS = 10 * 60 * 1000;
export const WHISPER_OVERLAP_MS = 5 * 1000;

/** How many mass-processing files run at once. Each one streams from disk. */
export const DEFAULT_MASS_CONCURRENCY = 2;
export const MAX_MASS_CONCURRENCY = 4;
