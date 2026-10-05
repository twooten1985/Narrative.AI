var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var keyStore_exports = {};
__export(keyStore_exports, {
  SECRET_NAMES: () => SECRET_NAMES,
  clearSecret: () => clearSecret,
  emptyStore: () => emptyStore,
  hasSecret: () => hasSecret,
  parseStore: () => parseStore,
  planMigration: () => planMigration,
  readSecret: () => readSecret,
  serializeStore: () => serializeStore,
  setSecret: () => setSecret
});
module.exports = __toCommonJS(keyStore_exports);
const SECRET_NAMES = ["assemblyai", "gemini"];
function emptyStore() {
  return { v: 1 };
}
function parseStore(raw) {
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw);
    const store = emptyStore();
    if (typeof parsed?.assemblyai === "string") store.assemblyai = parsed.assemblyai;
    if (typeof parsed?.gemini === "string") store.gemini = parsed.gemini;
    return store;
  } catch {
    return emptyStore();
  }
}
function serializeStore(store) {
  return JSON.stringify({ v: 1, assemblyai: store.assemblyai, gemini: store.gemini });
}
function setSecret(store, name, plain, cipher) {
  const next = { ...store, v: 1 };
  const value = plain.trim();
  if (!value) {
    delete next[name];
    return next;
  }
  next[name] = cipher.encrypt(value);
  return next;
}
function clearSecret(store, name) {
  const next = { ...store, v: 1 };
  delete next[name];
  return next;
}
function hasSecret(store, name) {
  return typeof store[name] === "string" && store[name].length > 0;
}
function readSecret(store, name, cipher) {
  const payload = store[name];
  if (!payload) return null;
  const plain = cipher.decrypt(payload);
  return plain ? plain : null;
}
function planMigration(incoming, store) {
  const planned = [];
  for (const name of SECRET_NAMES) {
    const value = incoming[name];
    if (typeof value === "string" && value.trim() && !hasSecret(store, name)) {
      planned.push({ name, value: value.trim() });
    }
  }
  return planned;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SECRET_NAMES,
  clearSecret,
  emptyStore,
  hasSecret,
  parseStore,
  planMigration,
  readSecret,
  serializeStore,
  setSecret
});
