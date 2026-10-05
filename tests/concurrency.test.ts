import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapPool } from "../src/services/concurrency.ts";

describe("mapPool", () => {
  it("keeps in-flight work at the limit and finishes every item", async () => {
    let current = 0;
    let max = 0;
    const items = Array.from({ length: 8 }, (_, index) => index);
    const results = await mapPool(items, 2, async (item) => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 15));
      current -= 1;
      return item * 2;
    });
    assert.equal(max, 2);
    assert.deepEqual(results, items.map((item) => item * 2));
  });
});
