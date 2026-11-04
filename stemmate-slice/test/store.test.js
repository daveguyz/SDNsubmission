// Unit tests for the encrypted per-facilitator store.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PlanStore, MemoryStorage, WrongPinError, LockedError } from "../src/store.js";
import { newPlan } from "../src/core.js";

const A = JSON.parse(fs.readFileSync(new URL("../data/catalogue.json", import.meta.url))).activities;
const FAST = { iterations: 1000 }; // production uses 210 000; lowered only to keep tests quick

test("AT-07 QR-03 drafts are encrypted at rest – no plan text appears in device storage", async () => {
  const st = new MemoryStorage();
  const s = await new PlanStore(st, "f1", FAST).unlock("1234");
  const p = newPlan(A[0], "f1", "p-store001"); p.title = "Okahandja Saturday club UNIQUE-MARKER";
  await s.put(p);
  assert.equal(st.dump().includes("UNIQUE-MARKER"), false);
  assert.equal(st.dump().includes("Balloon"), false);
});

test("AT-08 QR-03 wrong PIN is refused; sign-out locks drafts without deleting them", async () => {
  const st = new MemoryStorage();
  const s = await new PlanStore(st, "f1", FAST).unlock("1234");
  await s.put(newPlan(A[0], "f1", "p-store002"));
  s.lock();
  assert.throws(() => s.list(), LockedError);
  await assert.rejects(new PlanStore(st, "f1", FAST).unlock("0000"), WrongPinError);
  const again = await new PlanStore(st, "f1", FAST).unlock("1234");
  assert.equal(again.list().length, 1);
});

test("AT-09 FR-04 a saved draft survives an app restart (new store instance, same storage)", async () => {
  const st = new MemoryStorage();
  const s1 = await new PlanStore(st, "f1", FAST).unlock("1234");
  const p = newPlan(A[1], "f1", "p-store003"); p.incl = "Picture cards for each layer";
  await s1.put(p);
  // simulate closing the app: discard every in-memory object
  const s2 = await new PlanStore(st, "f1", FAST).unlock("1234");
  assert.equal(s2.get("p-store003").incl, "Picture cards for each layer");
});

test("AT-10 QR-03 a second facilitator on the same phone cannot open the first one's drafts", async () => {
  const st = new MemoryStorage();
  const selma = await new PlanStore(st, "f1", FAST).unlock("1234");
  await selma.put(newPlan(A[0], "f1", "p-store004"));
  const johannes = await new PlanStore(st, "f2", FAST).unlock("5678");
  assert.equal(johannes.list().length, 0);
  // even with Selma's storage key, Johannes's PIN does not decrypt her vault
  await assert.rejects(new PlanStore(st, "f1", FAST).unlock("5678"), WrongPinError);
});
