// Pure key-file logic. Electron main encrypts with safeStorage and is the only
// process that calls readSecret. The preload bridge exposes set / clear / has only.

export type SecretName = "assemblyai" | "gemini";

export const SECRET_NAMES: SecretName[] = ["assemblyai", "gemini"];

export interface SecretStore {
  v: 1;
  assemblyai?: string;
  gemini?: string;
}

export interface Cipher {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

export function emptyStore(): SecretStore {
  return { v: 1 };
}

export function parseStore(raw: string | null | undefined): SecretStore {
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

export function serializeStore(store: SecretStore): string {
  return JSON.stringify({ v: 1, assemblyai: store.assemblyai, gemini: store.gemini });
}

export function setSecret(store: SecretStore, name: SecretName, plain: string, cipher: Cipher): SecretStore {
  const next: SecretStore = { ...store, v: 1 };
  const value = plain.trim();
  if (!value) {
    delete next[name];
    return next;
  }
  next[name] = cipher.encrypt(value);
  return next;
}

export function clearSecret(store: SecretStore, name: SecretName): SecretStore {
  const next: SecretStore = { ...store, v: 1 };
  delete next[name];
  return next;
}

export function hasSecret(store: SecretStore, name: SecretName): boolean {
  return typeof store[name] === "string" && store[name]!.length > 0;
}

export function readSecret(store: SecretStore, name: SecretName, cipher: Cipher): string | null {
  const payload = store[name];
  if (!payload) return null;
  const plain = cipher.decrypt(payload);
  return plain ? plain : null;
}

/** Keys to copy out of renderer localStorage. Never overwrites a key already stored. */
export function planMigration(
  incoming: Partial<Record<SecretName, string | null | undefined>>,
  store: SecretStore
): { name: SecretName; value: string }[] {
  const planned: { name: SecretName; value: string }[] = [];
  for (const name of SECRET_NAMES) {
    const value = incoming[name];
    if (typeof value === "string" && value.trim() && !hasSecret(store, name)) {
      planned.push({ name, value: value.trim() });
    }
  }
  return planned;
}
