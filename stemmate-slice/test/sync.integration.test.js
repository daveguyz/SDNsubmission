// Integration tests: browser-side store + sync engine talking HTTP to the real server,
// which persists to a JSON file. Each test gets its own server and data file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server/server.js";
import { PlanStore, MemoryStorage } from "../src/store.js";
import { SyncEngine, HttpTransport } from "../src/sync.js";
import { newPlan, markComplete, toWire } from "../src/core.js";

const A = JSON.parse(fs.readFileSync(new URL("../data/catalogue.json", import.meta.url))).activities;

async function rig() {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stemmate-")), "plans.json");
  const server = createServer({ dbFile });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let offline = false;
  const transport = new HttpTransport(base, { isOffline: () => offline });
  const store = await new PlanStore(new MemoryStorage(), "f1", { iterations: 1000 }).unlock("1234");
  const engine = new SyncEngine(store, transport);
  const plan = Object.assign(newPlan(A[2], "f1", "p-integ0001"), { date: "2026-11-12", incl: "Home language first." });
  assert.deepEqual(markComplete(plan), []);
  await store.put(plan);
  const api = (p, o) => fetch(base + p, o);
  return { server, base, dbFile, store, engine, transport, plan, api, setOffline: v => (offline = v), close: () => new Promise(r => server.close(r)) };
}

test("AT-11 FR-06 completed plan is delivered and persists on the server across a restart", async () => {
  const r = await rig();
  try {
    const out = await r.engine.runOnce();
    assert.deepEqual(out, [{ id: "p-integ0001", result: "synced" }]);
    assert.equal(r.store.get("p-integ0001").sync, "SYNCHRONISED");
    assert.equal(r.store.get("p-integ0001").baseRev, 1);
    await r.close();
    const again = createServer({ dbFile: r.dbFile });
    assert.equal(again.db.get("p-integ0001").plan.title, r.plan.title);
  } finally { r.server.listening && await r.close(); }
});

test("AT-12 FR-06 a repeated send after a lost response does not create a duplicate", async () => {
  const r = await rig();
  try {
    const w = toWire(r.plan);
    const first = await r.transport.put(r.plan.id, w, 0, r.plan.editId);
    const replay = await r.transport.put(r.plan.id, w, 0, r.plan.editId); // response to first was "lost"
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    const stored = JSON.parse(fs.readFileSync(r.dbFile, "utf8"));
    assert.equal(Object.keys(stored.plans).length, 1);
    assert.equal(stored.plans["p-integ0001"].rev, 1);
  } finally { await r.close(); }
});

test("AT-13 FR-06 / FR-07 three server errors give 'Sync failed'; Retry then delivers", async () => {
  const r = await rig();
  try {
    await r.api("/api/_test/fail?count=3", { method: "POST" });
    const seen = [];
    for (let i = 0; i < 3; i++) { await r.engine.runOnce(); seen.push(r.store.get(r.plan.id).sync); }
    assert.deepEqual(seen, ["PENDING", "PENDING", "FAILED"]);
    assert.equal(r.store.get(r.plan.id).attempts, 3);
    await r.engine.retry(r.plan.id);
    await r.engine.runOnce();
    assert.equal(r.store.get(r.plan.id).sync, "SYNCHRONISED");
  } finally { await r.close(); }
});

test("AT-14 QR-01 / FR-06 with no signal the plan stays queued and no attempt is used up", async () => {
  const r = await rig();
  try {
    r.setOffline(true);
    const out = await r.engine.runOnce();
    assert.deepEqual(out, [{ id: r.plan.id, result: "offline" }]);
    assert.equal(r.store.get(r.plan.id).sync, "PENDING");
    assert.equal(r.store.get(r.plan.id).attempts, 0);
    r.setOffline(false);
    await r.engine.runOnce();
    assert.equal(r.store.get(r.plan.id).sync, "SYNCHRONISED");
  } finally { await r.close(); }
});

async function makeConflict(r) {
  await r.engine.runOnce();                                             // rev 1 on server
  await r.api(`/api/outreach/plans/${r.plan.id}/edit`, { method: "POST" }); // outreach edits → rev 2
  const p = r.store.get(r.plan.id);                                     // facilitator edits offline copy
  p.state = "DRAFT"; p.steps.push({ t: "Clean up and wipe tables", m: 5 });
  assert.deepEqual(markComplete(p), []);
  await r.store.put(p);
  await r.engine.runOnce();
}

test("AT-15 FR-06 an edit by the outreach unit causes a conflict and neither copy is overwritten", async () => {
  const r = await rig();
  try {
    await makeConflict(r);
    const p = r.store.get(r.plan.id);
    assert.equal(p.sync, "CONFLICT");
    assert.equal(p.serverCopy.rev, 2);
    assert.ok(p.steps.some(s => s.t === "Clean up and wipe tables"));                  // phone copy intact
    const srv = await (await r.api(`/api/plans/${r.plan.id}`)).json();
    assert.ok(srv.plan.steps.some(s => s.t.startsWith("Hand out safety goggles")));     // server copy intact
    assert.equal(srv.plan.steps.some(s => s.t === "Clean up and wipe tables"), false);
  } finally { await r.close(); }
});

test("AT-16 FR-06 'Keep this phone's version' then delivers the phone copy", async () => {
  const r = await rig();
  try {
    await makeConflict(r);
    await r.engine.keepLocal(r.plan.id);
    await r.engine.runOnce();
    assert.equal(r.store.get(r.plan.id).sync, "SYNCHRONISED");
    const srv = await (await r.api(`/api/plans/${r.plan.id}`)).json();
    assert.equal(srv.rev, 3);
    assert.ok(srv.plan.steps.some(s => s.t === "Clean up and wipe tables"));
  } finally { await r.close(); }
});

test("AT-17 FR-06 'Use outreach unit copy' replaces the phone copy and marks it sent", async () => {
  const r = await rig();
  try {
    await makeConflict(r);
    await r.engine.useServer(r.plan.id);
    const p = r.store.get(r.plan.id);
    assert.equal(p.sync, "SYNCHRONISED");
    assert.equal(p.baseRev, 2);
    assert.ok(p.steps.some(s => s.t.startsWith("Hand out safety goggles")));
  } finally { await r.close(); }
});

test("AT-18 QR-03 / QR-01 server rejects incomplete plans, unexpected fields and oversized requests", async () => {
  const r = await rig();
  try {
    const put = (body, rev = 0) => r.api(`/api/plans/${r.plan.id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": String(rev) }, body: JSON.stringify(body) });
    const w = toWire(r.plan);
    assert.equal((await put({ plan: { ...w, safety: "" }, editId: "a" })).status, 422);
    assert.equal((await put({ plan: { ...w, learnerName: "X" }, editId: "b" })).status, 400);
    assert.equal((await put({ plan: { ...w, safety: "x".repeat(600 * 1024) }, editId: "c" }).catch(() => ({ status: 413 }))).status, 413);
    assert.equal((await r.api("/api/plans/..%2F..%2Fetc")).status, 400);
  } finally { await r.close(); }
});
