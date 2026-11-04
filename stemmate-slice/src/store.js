// Encrypted per-facilitator plan store (QR-03, FR-04).
// Each facilitator's plans are one AES-256-GCM "vault" in key-value storage
// (localStorage in the browser, a Map in tests). The key is derived from the
// facilitator's PIN with PBKDF2 and is held only in memory: lock() forgets it,
// so the next person on a shared phone cannot read the drafts, but nothing is deleted.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
export const PBKDF2_ITERATIONS = 210000;

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export class WrongPinError extends Error { constructor() { super("PIN does not match"); this.name = "WrongPinError"; } }
export class LockedError extends Error { constructor() { super("Store is locked"); this.name = "LockedError"; } }

export async function deriveKey(pin, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle.importKey("raw", enc.encode(String(pin)), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptJSON(key, obj) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function decryptJSON(key, box) {
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

export class PlanStore {
  constructor(storage, facilitatorId, { iterations = PBKDF2_ITERATIONS } = {}) {
    this.storage = storage; this.fid = facilitatorId; this.iterations = iterations;
    this.key = null; this.plans = null;
  }
  get vaultKey() { return `stemmate.vault.${this.fid}`; }
  get saltKey() { return `stemmate.salt.${this.fid}`; }
  exists() { return this.storage.getItem(this.vaultKey) != null; }

  // Opens the vault. Creates an empty one if this facilitator has never signed in on this device.
  async unlock(pin) {
    let salt = this.storage.getItem(this.saltKey);
    if (!salt) { salt = b64(globalThis.crypto.getRandomValues(new Uint8Array(16))); this.storage.setItem(this.saltKey, salt); }
    const key = await deriveKey(pin, unb64(salt), this.iterations);
    const raw = this.storage.getItem(this.vaultKey);
    if (raw == null) { this.key = key; this.plans = []; await this.flush(); return this; }
    try { this.plans = (await decryptJSON(key, JSON.parse(raw))).plans; }
    catch { throw new WrongPinError(); }
    this.key = key;
    return this;
  }
  lock() { this.key = null; this.plans = null; }
  get unlocked() { return this.key != null; }

  async flush() {
    if (!this.key) throw new LockedError();
    const box = await encryptJSON(this.key, { v: 1, plans: this.plans });
    this.storage.setItem(this.vaultKey, JSON.stringify(box)); // single write: no half-saved vault
  }
  list() { if (!this.key) throw new LockedError(); return this.plans; }
  get(id) { return this.list().find(p => p.id === id) || null; }
  async put(plan) {
    const list = this.list();
    plan.updatedAt = new Date().toISOString();
    const i = list.findIndex(p => p.id === plan.id);
    if (i >= 0) list[i] = plan; else list.unshift(plan);
    await this.flush();
    return plan;
  }
  async remove(id) { this.plans = this.list().filter(p => p.id !== id); await this.flush(); }
}

// Minimal in-memory storage with the localStorage interface, for tests.
export class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  dump() { return [...this.m.values()].join("\n"); }
}
