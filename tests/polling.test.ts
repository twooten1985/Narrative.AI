import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTransientClientError, pollWithBackoff } from "../src/services/polling.ts";

describe("pollWithBackoff transient localhost errors", () => {
  it("retries Failed to fetch a few times and then returns the job", async () => {
    let calls = 0;
    const notes: number[] = [];
    const value = await pollWithBackoff({
      sleepImpl: async () => {},
      initialDelayMs: 1,
      maxDelayMs: 5,
      timeoutMs: 10_000,
      maxTransientRetries: 4,
      poll: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("Failed to fetch");
        return { status: "completed", progress: 40 };
      },
      isDone: (row) => row.status === "completed",
      onTransientError: (_error, attempt) => notes.push(attempt),
    });
    assert.equal(value.progress, 40);
    assert.equal(calls, 3);
    assert.deepEqual(notes, [1, 2]);
  });

  it("gives up after a few Failed to fetch errors with a local-server message", async () => {
    let calls = 0;
    await assert.rejects(
      () => pollWithBackoff({
        sleepImpl: async () => {},
        timeoutMs: 10_000,
        maxTransientRetries: 2,
        poll: async () => {
          calls += 1;
          const error = new TypeError("fetch failed");
          (error as TypeError & { cause?: unknown }).cause = { code: "ECONNRESET", message: "socket hang up" };
          throw error;
        },
        isDone: () => false,
      }),
      /Lost contact with the local Narrative AI server/,
    );
    assert.equal(calls, 3);
    assert.equal(isTransientClientError(new TypeError("Failed to fetch")), true);
    assert.equal(isTransientClientError(new Error("Failed to fetch statistics")), false);
  });

  it("does not retry an HTTP error from the local API", async () => {
    let calls = 0;
    await assert.rejects(
      () => pollWithBackoff({
        sleepImpl: async () => {},
        timeoutMs: 10_000,
        poll: async () => {
          calls += 1;
          throw new Error("Job not found");
        },
        isDone: () => false,
      }),
      /Job not found/,
    );
    assert.equal(calls, 1);
  });
});
