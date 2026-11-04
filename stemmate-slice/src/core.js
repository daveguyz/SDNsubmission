// STEMMate vertical slice – domain logic (no I/O). Shared by the browser app,
// the sync server and the automated tests, so validation rules exist once.
// Requirement IDs refer to the A3 baseline (FR-01 … SR-01).

export const PLAN_STATES = Object.freeze(["DRAFT", "COMPLETE"]);
export const SYNC_STATES = Object.freeze(["NOT_QUEUED", "PENDING", "SYNCING", "SYNCHRONISED", "FAILED", "CONFLICT"]);
export const MAX_STEPS = 30;
export const MAX_TEXT = 2000;
export const ID_PATTERN = /^p-[a-z0-9]{8,32}$/;

// FR-01: return only activities whose required materials are all selected.
export function filterActivities(activities, f = {}) {
  const mat = f.mat || [];
  return activities.filter(a =>
    (!f.level || a.level === f.level) &&
    (!f.topic || a.topic === f.topic) &&
    (!f.mins || a.mins <= Number(f.mins)) &&
    (mat.length === 0 || a.mat.every(m => mat.includes(m))));
}

export function newId(rand = Math.random) {
  let s = "";
  while (s.length < 12) s += Math.floor(rand() * 36).toString(36);
  return "p-" + s;
}

// FR-03: a plan is created from exactly one activity.
export function newPlan(activity, ownerId, id = newId()) {
  return {
    id, owner: ownerId, act: activity.id,
    title: activity.name + " – new session", date: "",
    steps: activity.steps.map(([t, m]) => ({ t, m })),
    safety: activity.safety, incl: "",
    counts: [0, 0, 0, 0],
    state: "DRAFT", sync: "NOT_QUEUED",
    baseRev: 0, editId: null, attempts: 0, serverCopy: null, syncedAt: null,
    updatedAt: null
  };
}

// FR-05: counts only, whole numbers, never negative.
export function sanitiseCounts(counts, n = 4) {
  return Array.from({ length: n }, (_, i) => {
    const v = Math.floor(Number(counts?.[i]));
    return Number.isFinite(v) && v > 0 ? Math.min(v, 9999) : 0;
  });
}

// FR-03 / QR-02 (3.3.1, 3.3.3): every error names the field and the fix.
export function validatePlan(p) {
  const errs = [];
  if (!p || typeof p !== "object") return [{ field: "plan", msg: "Plan is missing." }];
  if (!String(p.title || "").trim()) errs.push({ field: "title", msg: "Give the plan a name." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || "")) errs.push({ field: "date", msg: "Add the session date." });
  if (!Array.isArray(p.steps) || p.steps.length === 0) errs.push({ field: "steps", msg: "Add at least one step." });
  else if (p.steps.length > MAX_STEPS) errs.push({ field: "steps", msg: `Use ${MAX_STEPS} steps or fewer.` });
  else if (p.steps.some(s => !String(s.t || "").trim() || !(Number(s.m) > 0)))
    errs.push({ field: "steps", msg: "Every step needs a description and minutes above 0." });
  if (!String(p.safety || "").trim()) errs.push({ field: "safety", msg: "Write the safety notes." });
  if (!String(p.incl || "").trim()) errs.push({ field: "incl", msg: "Write an inclusion prompt." });
  for (const k of ["title", "safety", "incl"])
    if (String(p[k] || "").length > MAX_TEXT) errs.push({ field: k, msg: `Keep this under ${MAX_TEXT} characters.` });
  return errs;
}

export function totalMinutes(p) { return p.steps.reduce((x, s) => x + Number(s.m || 0), 0); }

export function moveStep(p, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= p.steps.length) return false;
  [p.steps[i], p.steps[j]] = [p.steps[j], p.steps[i]];
  return true;
}

// FR-06: only a valid plan becomes COMPLETE and is queued. editId makes the
// upload idempotent: a repeat of the same send cannot create a second copy.
export function markComplete(p, rand = Math.random) {
  const errs = validatePlan(p);
  if (errs.length) return errs;
  p.state = "COMPLETE";
  p.sync = "PENDING";
  p.attempts = 0;
  p.editId = newId(rand).slice(2);
  return [];
}

export function reopen(p) {
  p.state = "DRAFT";
  p.sync = "NOT_QUEUED";
}

// QR-03 data minimisation: only these fields ever leave the device.
export const WIRE_FIELDS = Object.freeze(["id", "act", "title", "date", "steps", "safety", "incl", "counts"]);
export function toWire(p) {
  const w = {};
  for (const k of WIRE_FIELDS) w[k] = p[k];
  w.steps = p.steps.map(s => ({ t: String(s.t), m: Number(s.m) }));
  w.counts = sanitiseCounts(p.counts);
  return w;
}
export function hasOnlyWireFields(obj) {
  return obj && typeof obj === "object" && Object.keys(obj).every(k => WIRE_FIELDS.includes(k));
}

export function diffFields(local, server) {
  return ["date", "steps", "safety", "incl", "counts"].filter(k => JSON.stringify(local[k]) !== JSON.stringify(server[k]));
}
