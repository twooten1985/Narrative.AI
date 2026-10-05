import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  clearSecret,
  emptyStore,
  hasSecret,
  parseStore,
  planMigration,
  readSecret,
  serializeStore,
  setSecret,
  type Cipher,
} from "../src/services/keyStore.ts";

const cipher: Cipher = {
  encrypt: (plain) => Buffer.from(`v1:${plain}`, "utf8").toString("base64"),
  decrypt: (payload) => {
    const text = Buffer.from(payload, "base64").toString("utf8");
    if (!text.startsWith("v1:")) throw new Error("bad payload");
    return text.slice(3);
  },
};

describe("key storage", () => {
  it("round-trips a key and does not keep plaintext", () => {
    let store = emptyStore();
    store = setSecret(store, "assemblyai", " secret-key ", cipher);
    const saved = serializeStore(store);
    assert.equal(saved.includes("secret-key"), false);
    const loaded = parseStore(saved);
    assert.equal(hasSecret(loaded, "assemblyai"), true);
    assert.equal(readSecret(loaded, "assemblyai", cipher), "secret-key");
    assert.equal(readSecret(clearSecret(loaded, "assemblyai"), "assemblyai", cipher), null);
  });

  it("plans a one-time migration without overwriting a saved key", () => {
    const store = setSecret(emptyStore(), "assemblyai", "already", cipher);
    const planned = planMigration({ assemblyai: "from-browser", gemini: " gem-key " }, store);
    assert.deepEqual(planned, [{ name: "gemini", value: "gem-key" }]);
    assert.deepEqual(planMigration({ assemblyai: "  ", gemini: "" }, emptyStore()), []);
  });

  it("preload exposes set, clear, and has, and not a reader", () => {
    const preload = fs.readFileSync(path.join(process.cwd(), "preload.cjs"), "utf8");
    assert.match(preload, /setKey:/);
    assert.match(preload, /clearKey:/);
    assert.match(preload, /hasKey:/);
    assert.equal(/getKey|readSecret|decryptString|safeStorage/.test(preload), false);
  });
});
