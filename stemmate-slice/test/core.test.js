// Unit tests for domain logic. Test IDs match the A4 traceability matrix.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { filterActivities, newPlan, validatePlan, markComplete, moveStep, sanitiseCounts, toWire, WIRE_FIELDS } from "../src/core.js";

const CAT = JSON.parse(fs.readFileSync(new URL("../data/catalogue.json", import.meta.url)));
const A = CAT.activities;
const validPlan = () => Object.assign(newPlan(A[2], "f1", "p-test0001"), { date: "2026-11-12", incl: "Describe it in a home language first." });

test("AT-01 FR-01 materials filter returns only activities whose materials are all on hand", () => {
  const r = filterActivities(A, { mat: ["Balloons", "String", "Straws", "Tape"] });
  assert.deepEqual(r.map(a => a.id), ["a1"]);
  for (const a of r) assert.ok(a.mat.every(m => ["Balloons", "String", "Straws", "Tape"].includes(m)));
});

test("AT-02 FR-01 level, topic and duration filters combine; impossible filter returns empty list", () => {
  assert.deepEqual(filterActivities(A, { topic: "Physics", mins: 45 }).map(a => a.id), ["a1", "a6", "a7"]);
  assert.deepEqual(filterActivities(A, { level: "Grade 3-5", topic: "Physics" }).map(a => a.id), ["a7"]);
  assert.equal(filterActivities(A, { mat: ["Water"] }).length, 0);
});

test("AT-03 QR-01 filtering a 500-activity catalogue takes under 1 second", () => {
  const big = Array.from({ length: 500 }, (_, i) => ({ ...A[i % A.length], id: "x" + i }));
  const t0 = performance.now();
  for (let k = 0; k < 20; k++) filterActivities(big, { mat: CAT.materials.slice(0, 8), mins: 60 });
  const perRun = (performance.now() - t0) / 20;
  assert.ok(perRun < 1000, `took ${perRun} ms`);
});

test("AT-04 FR-03 incomplete plan cannot be marked complete; every missing field is reported", () => {
  const p = newPlan(A[2], "f1", "p-test0002");
  p.safety = ""; p.steps = [];
  const errs = markComplete(p);
  assert.deepEqual(errs.map(e => e.field).sort(), ["date", "incl", "safety", "steps"]);
  assert.equal(p.state, "DRAFT");
  assert.equal(p.sync, "NOT_QUEUED");
  const ok = validPlan();
  assert.deepEqual(markComplete(ok), []);
  assert.equal(ok.state, "COMPLETE"); assert.equal(ok.sync, "PENDING"); assert.ok(ok.editId);
});

test("AT-05 FR-03 steps reorder with Up/Down and stay within bounds", () => {
  const p = validPlan();
  const first = p.steps[0].t, second = p.steps[1].t;
  assert.equal(moveStep(p, 1, -1), true);
  assert.deepEqual([p.steps[0].t, p.steps[1].t], [second, first]);
  assert.equal(moveStep(p, 0, -1), false);
  assert.equal(moveStep(p, p.steps.length - 1, +1), false);
});

test("AT-06 FR-05 / QR-03 only counts and domain fields leave the device", () => {
  assert.deepEqual(sanitiseCounts([3, -2, "7", "abc", 2.9]), [3, 0, 7, 0]);
  const p = validPlan();
  p.learnerNames = "Should never be sent"; p.owner = "f1"; p.serverCopy = { x: 1 };
  const w = toWire(p);
  assert.deepEqual(Object.keys(w).sort(), [...WIRE_FIELDS].sort());
  assert.equal(JSON.stringify(w).includes("Should never be sent"), false);
});
