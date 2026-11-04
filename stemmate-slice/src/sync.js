// Sync engine (FR-06, FR-07, QR-04). Revision-based, never last-write-wins:
// each upload is a conditional PUT carrying the server revision the device last saw
// (If-Match) and an editId that makes a repeated send idempotent.
import { toWire } from "./core.js";

export const MAX_ATTEMPTS = 3;

export class OfflineError extends Error { constructor() { super("offline"); this.name = "OfflineError"; } }

// Browser/Node fetch transport. `isOffline` lets the demo's test control simulate signal loss.
export class HttpTransport {
  constructor(baseUrl = "", { fetchFn = globalThis.fetch.bind(globalThis), isOffline = () => false } = {}) {
    this.base = baseUrl; this.fetch = fetchFn; this.isOffline = isOffline;
  }
  async put(id, wire, baseRev, editId) {
    if (this.isOffline()) throw new OfflineError();
    let res;
    try {
      res = await this.fetch(`${this.base}/api/plans/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": String(baseRev) },
        body: JSON.stringify({ plan: wire, editId })
      });
    } catch { throw new OfflineError(); }
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }
}

export class SyncEngine {
  constructor(store, transport, { now = () => new Date(), onChange = () => {} } = {}) {
    this.store = store; this.transport = transport; this.now = now; this.onChange = onChange;
    this.busy = false;
  }
  queued() { return this.store.list().filter(p => p.sync === "PENDING"); }

  // Sends every PENDING plan once. Returns a list of {id, result} for the UI to announce.
  async runOnce() {
    if (this.busy || !this.store.unlocked) return [];
    this.busy = true;
    const out = [];
    try {
      for (const p of this.queued()) {
        p.sync = "SYNCING"; await this.store.put(p); this.onChange(p);
        let r;
        try { r = await this.transport.put(p.id, toWire(p), p.baseRev, p.editId); }
        catch (e) {
          // No signal: keep it queued, do not count as a failed attempt.
          p.sync = "PENDING"; await this.store.put(p); this.onChange(p);
          out.push({ id: p.id, result: "offline" });
          break;
        }
        if (r.status === 200 || r.status === 201) {
          p.sync = "SYNCHRONISED"; p.baseRev = r.body.rev; p.attempts = 0; p.serverCopy = null;
          p.syncedAt = this.now().toISOString();
          out.push({ id: p.id, result: "synced" });
        } else if (r.status === 412) {
          p.sync = "CONFLICT"; p.serverCopy = r.body.server;
          out.push({ id: p.id, result: "conflict" });
        } else if (r.status === 422 || r.status === 413 || r.status === 400) {
          p.sync = "FAILED"; p.attempts = MAX_ATTEMPTS; p.lastError = r.body.error || `HTTP ${r.status}`;
          out.push({ id: p.id, result: "rejected" });
        } else {
          p.attempts++;
          p.lastError = `HTTP ${r.status}`;
          p.sync = p.attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING";
          out.push({ id: p.id, result: p.sync === "FAILED" ? "failed" : "retry" });
        }
        await this.store.put(p); this.onChange(p);
      }
    } finally { this.busy = false; }
    return out;
  }

  async retry(id) {
    const p = this.store.get(id);
    p.sync = "PENDING"; p.attempts = 0; await this.store.put(p);
  }

  // Conflict resolution (FR-06): overwrite neither copy until the facilitator chooses.
  async keepLocal(id) {
    const p = this.store.get(id);
    // Redesign R3 (found by AT-16): re-base onto the server revision the facilitator has now
    // seen, otherwise the next conditional PUT is refused again and the plan loops in CONFLICT.
    p.baseRev = p.serverCopy.rev;
    p.serverCopy = null; p.sync = "PENDING"; p.attempts = 0;
    await this.store.put(p);
  }
  async useServer(id) {
    const p = this.store.get(id), s = p.serverCopy;
    Object.assign(p, { title: s.title, date: s.date, steps: s.steps, safety: s.safety, incl: s.incl, counts: s.counts });
    p.baseRev = s.rev; p.serverCopy = null; p.sync = "SYNCHRONISED"; p.syncedAt = this.now().toISOString();
    await this.store.put(p);
  }
}
