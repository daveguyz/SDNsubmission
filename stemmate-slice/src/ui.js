// STEMMate vertical slice – presentation layer. Thin: all rules live in core.js,
// storage in store.js and delivery in sync.js.
import { filterActivities, newPlan, validatePlan, markComplete, reopen, moveStep, sanitiseCounts, totalMinutes, diffFields } from "./core.js";
import { PlanStore, WrongPinError } from "./store.js";
import { SyncEngine, HttpTransport } from "./sync.js";

const FACS = [{ id: "f1", name: "Selma (demo)", pin: "1234" }, { id: "f2", name: "Johannes (demo)", pin: "5678" }];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hhmm = iso => iso ? new Date(iso).toTimeString().slice(0, 5) : "";
function say(msg) { const l = $("#live"); l.textContent = ""; setTimeout(() => (l.textContent = msg), 60); }

let CAT, LABELS, store = null, engine = null, user = null;
let simOffline = false;
try { simOffline = localStorage.getItem("stemmate.simOffline") === "1"; } catch {}
const offline = () => simOffline || !navigator.onLine;
const transport = new HttpTransport("", { isOffline: offline });

/* ---------- boot ---------- */
async function boot() {
  try {
    [CAT, LABELS] = await Promise.all([fetch("/data/catalogue.json").then(r => r.json()), fetch("/data/labels.json").then(r => r.json())]);
  } catch {
    $("#main").innerHTML = `<div class="notice bad" role="alert"><strong>STEMMate could not start.</strong> Open it once with signal so it can be saved on this phone.</div>`;
    return;
  }
  // Demo seeding: give the two synthetic facilitators a vault under their demo PIN.
  for (const f of FACS) { const s = new PlanStore(localStorage, f.id); if (!s.exists()) await s.unlock(f.pin); }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  window.addEventListener("hashchange", () => flushDraft().then(render));
  window.addEventListener("online", () => { renderChrome(); kick(); });
  window.addEventListener("offline", () => renderChrome());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushDraft(); });
  setInterval(kick, 20000);
  wireTools();
  render();
}

/* ---------- chrome ---------- */
function chip(p) {
  const l = LABELS.status[p.sync];
  const when = p.sync === "SYNCHRONISED" && p.syncedAt ? " " + hhmm(p.syncedAt) : "";
  return `<span class="chip ${l.css}"><span aria-hidden="true">${l.icon}</span>${esc(l.text)}${when}</span>`;
}
function renderChrome(route = location.hash.slice(1).split("/")[0]) {
  // Issue I-05: v1.3-rc counted failed plans as "Sending…"; queued and failed are now reported separately.
  const mine = store?.unlocked ? store.list() : [];
  const q = mine.filter(p => ["PENDING", "SYNCING"].includes(p.sync)).length;
  const f = mine.filter(p => p.sync === "FAILED").length;
  const failTxt = f ? ` ${f} plan${f > 1 ? "s" : ""} not sent – use Retry on My plans.` : "";
  const nb = $("#netbar");
  if (offline()) { nb.className = "netbar off"; nb.innerHTML = `<span aria-hidden="true">⚠</span><span><strong>No signal.</strong> Your plans are safe on this phone.${q ? ` ${q} waiting to send.` : ""}${failTxt}</span>`; }
  else { nb.className = f ? "netbar off" : "netbar on"; nb.innerHTML = `<span aria-hidden="true">${f ? "⚠" : "●"}</span><span><strong>Online.</strong>${q ? ` Sending ${q} plan${q > 1 ? "s" : ""}…` : ""}${failTxt}${!q && !f ? " Everything is sent." : ""}</span>`; }
  $("#who").innerHTML = user ? `<button type="button" id="signout">Sign out</button>` : "";
  if (user) $("#signout").onclick = async () => { await flushDraft(); store.lock(); store = engine = user = null; say("Signed out. Your drafts are locked on this phone."); go("#signin"); };
  const items = [["#plans", "My plans"], ["#catalogue", "Find activity"]];
  $("#nav").innerHTML = user ? items.map(([h, t]) => `<a href="${h}" ${route === h.slice(1) ? 'aria-current="page"' : ""}>${t}</a>`).join("") : "";
  $("#net-on").checked = !simOffline; $("#net-off").checked = simOffline;
}

/* ---------- router ---------- */
function go(h) { if (location.hash === h) render(); else location.hash = h; }
function render() {
  let [route, arg] = location.hash.slice(1).split("/");
  if (!user && route !== "signin") route = "signin";
  if (user && (!route || route === "signin")) route = "plans";
  const V = { signin, plans: plansView, catalogue, activity, edit, summary, conflict }[route] || plansView;
  $("#main").innerHTML = ""; V(arg); renderChrome(route);
  const h = $("#main h1"); if (h) { h.tabIndex = -1; h.focus(); document.title = h.textContent + " – STEMMate"; }
}

/* ---------- screens ---------- */
function signin() {
  $("#main").innerHTML = `<h1>Sign in</h1>
  <p class="muted">This phone may be shared. Each facilitator's plans are encrypted and only open with their own PIN.</p>
  <form id="f" novalidate>
   <label for="fac">Facilitator</label>
   <select id="fac">${FACS.map(f => `<option value="${f.id}">${f.name}</option>`).join("")}</select>
   <label for="pin">PIN <span class="hint">4 digits. Demo PINs: Selma 1234, Johannes 5678.</span></label>
   <input id="pin" type="password" inputmode="numeric" autocomplete="off" aria-describedby="pin-err">
   <div id="pin-err"></div>
   <div class="row"><button class="btn" type="submit" id="go">Sign in</button></div>
  </form>`;
  $("#f").onsubmit = async e => {
    e.preventDefault();
    const f = FACS.find(x => x.id === $("#fac").value);
    $("#go").disabled = true; $("#go").textContent = "Opening…";
    try {
      store = await new PlanStore(localStorage, f.id).unlock($("#pin").value);
      user = f; engine = new SyncEngine(store, transport, { onChange: () => refreshIfList() });
      say("Signed in as " + f.name); go("#plans"); kick();
    } catch (err) {
      $("#go").disabled = false; $("#go").textContent = "Sign in";
      if (!(err instanceof WrongPinError)) throw err;
      $("#pin").setAttribute("aria-invalid", "true");
      $("#pin-err").innerHTML = `<p class="err">That PIN does not match ${esc(f.name)}. Check the PIN and try again.</p>`;
      $("#pin").focus();
    }
  };
}

function plansView() {
  const ps = store.list();
  $("#main").innerHTML = `<h1>My plans</h1>
  ${ps.length ? `<ul class="list">${ps.map(p => `<li class="item"><h3><a href="#${p.sync === "CONFLICT" ? "conflict" : (p.state === "DRAFT" ? "edit" : "summary")}/${p.id}">${esc(p.title)}</a></h3>
   <p class="meta">${esc(act(p.act).name)} · ${esc(p.date || "no date yet")}</p><p style="margin:.4rem 0 0">${chip(p)}</p>
   ${p.sync === "FAILED" ? `<p class="err">This plan could not be sent after 3 tries. It is still safe on this phone.</p><button class="btn small" data-retry="${p.id}" type="button">Retry sending</button>` : ""}
   ${p.sync === "CONFLICT" ? `<p class="meta">The outreach unit changed this plan. Nothing has been overwritten. <a href="#conflict/${p.id}">Choose a version</a></p>` : ""}
  </li>`).join("")}</ul>` : `<p>You have no plans yet. Start by finding an activity that fits the materials you have.</p>`}
  <div class="row"><a class="btn" href="#catalogue">Find an activity</a></div>`;
  document.querySelectorAll("[data-retry]").forEach(b => b.onclick = async () => { await engine.retry(b.dataset.retry); say("Retry queued. It will send when there is signal."); render(); kick(); });
}

const act = id => CAT.activities.find(a => a.id === id);
let lastFilter = { level: "", mins: "", topic: "", mat: [] };
function catalogue() {
  const A = CAT.activities, lv = [...new Set(A.map(a => a.level))], tp = [...new Set(A.map(a => a.topic))], L = lastFilter;
  $("#main").innerHTML = `<h1>Find an activity</h1>
  <p class="muted">Tick the materials you have. Only activities you can run with them are shown.</p>
  <form id="ff">
   <fieldset><legend>Materials on hand</legend><div class="grid2">${CAT.materials.map(m => `<label class="check"><input type="checkbox" name="m" value="${m}" ${L.mat.includes(m) ? "checked" : ""}> ${m}</label>`).join("")}</div></fieldset>
   <label for="lv">Learner level</label><select id="lv"><option value="">Any level</option>${lv.map(l => `<option ${L.level === l ? "selected" : ""}>${l}</option>`).join("")}</select>
   <label for="tp">Topic</label><select id="tp"><option value="">Any topic</option>${tp.map(t => `<option ${L.topic === t ? "selected" : ""}>${t}</option>`).join("")}</select>
   <label for="mn">Longest session</label><select id="mn"><option value="">Any length</option>${[30, 45, 60].map(n => `<option value="${n}" ${L.mins == n ? "selected" : ""}>Up to ${n} minutes</option>`).join("")}</select>
   <div class="row"><button class="btn" type="submit">Show activities</button></div>
  </form>
  <h2 id="res-h">Results</h2><div id="res"></div>`;
  const show = () => {
    const r = filterActivities(A, lastFilter);
    $("#res").innerHTML = `<p id="rc"><strong>${r.length} activit${r.length === 1 ? "y" : "ies"}</strong> match${r.length === 1 ? "es" : ""}.</p>` + (r.length ? `<ul class="list">${r.map(a => `<li class="item"><h3><a href="#activity/${a.id}">${a.name}</a></h3><p class="meta">${a.topic} · ${a.level} · ${a.mins} min</p><p class="meta">Needs: ${a.mat.join(", ")}</p></li>`).join("")}</ul>` : `<p>Try unticking a filter, or add a material you could borrow.</p>`);
    return r.length;
  };
  show();
  $("#ff").onsubmit = e => { e.preventDefault(); lastFilter = { level: $("#lv").value, topic: $("#tp").value, mins: $("#mn").value, mat: [...document.querySelectorAll("[name=m]:checked")].map(x => x.value) }; const n = show(); say(n + " activities match."); $("#rc").tabIndex = -1; $("#rc").focus(); };
}

function activity(id) {
  const a = act(id); if (!a) return go("#catalogue");
  $("#main").innerHTML = `<p><a class="back" href="#catalogue">Back to results</a></p><h1>${a.name}</h1>
  <p class="meta">${a.topic} · ${a.level} · ${a.mins} min</p>
  <div class="row"><button class="btn" id="mk" type="button">Plan a session with this</button></div>
  <h2>Materials</h2><ul>${a.mat.map(m => `<li>${m}</li>`).join("")}</ul>
  <h2>Steps</h2><ol>${a.steps.map(s => `<li>${s[0]} (${s[1]} min)</li>`).join("")}</ol>
  <h2>Safety</h2><div class="notice warn"><span aria-hidden="true">⚠ </span>${a.safety}</div>
  <h2>Inclusion idea</h2><p>${a.incl}</p>`;
  $("#mk").onclick = async () => { const p = newPlan(a, user.id); await store.put(p); go("#edit/" + p.id); };
}

/* ---------- plan editor with autosave (FR-04) ----------
   Redesign R2: v1.2 read the form from the DOM 2 s after typing stopped; leaving the screen
   inside that window lost the text and threw an error. Now every keystroke updates the plan
   object at once, a 1 s debounce writes it, and any navigation flushes before the screen changes. */
let dirty = null, saveTimer = null;
async function flushDraft() {
  clearTimeout(saveTimer);
  if (!dirty || !store?.unlocked) { dirty = null; return; }
  const p = dirty; dirty = null;
  await store.put(p);
  const as = $("#as"); if (as) as.textContent = `Draft saved on this phone at ${hhmm(p.updatedAt)}`;
}
function touch(p, msg) {
  dirty = p; clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushDraft().then(() => msg && say(msg + " Draft saved.")), msg ? 0 : 1000);
}

function edit(id) {
  const p = store.get(id); if (!p) return go("#plans");
  if (p.state !== "DRAFT") return go("#summary/" + id);
  const a = act(p.act);
  $("#main").innerHTML = `<p><a class="back" href="#plans">Back to my plans</a></p><h1>Edit plan</h1>
  <p>${chip(p)} <span class="autosave" id="as" aria-live="polite">${p.updatedAt ? "Draft saved on this phone at " + hhmm(p.updatedAt) : ""}</span></p>
  <div id="es"></div>
  <label for="title">Plan name</label><input id="title" type="text" value="${esc(p.title)}" aria-describedby="title-err"><div id="title-err"></div>
  <label for="date">Session date</label><input id="date" type="date" value="${esc(p.date)}" aria-describedby="date-err"><div id="date-err"></div>
  <h2 id="steps-h">Steps</h2>
  <p class="hint">Use Up and Down to change the order. Total: <strong id="tot"></strong> minutes (activity guide: ${a.mins}).</p>
  <ol class="steps" id="steps" aria-labelledby="steps-h"></ol><div id="steps-err"></div>
  <fieldset><legend>Add a step</legend>
   <label for="ns">What happens</label><input id="ns" type="text">
   <label for="nm">Minutes</label><input id="nm" type="number" min="1" max="120" inputmode="numeric">
   <div id="ns-err"></div>
   <div class="row"><button class="btn sec small" id="add" type="button">Add step</button></div>
  </fieldset>
  <label for="safety">Safety notes <span class="hint">Required. What must adults check before and during the session?</span></label>
  <textarea id="safety" aria-describedby="safety-err">${esc(p.safety)}</textarea><div id="safety-err"></div>
  <label for="incl">Inclusion prompt <span class="hint">Required. How will every learner take part?</span></label>
  <textarea id="incl" aria-describedby="incl-err">${esc(p.incl)}</textarea><div id="incl-err"></div>
  <fieldset><legend>Participation (numbers only, no names)</legend>
   <p class="hint">Fill in after the session. Leave at 0 before it runs.</p>
   ${CAT.categories.map((c, i) => `<label for="c${i}">${c}</label><input id="c${i}" type="number" min="0" inputmode="numeric" value="${p.counts[i]}">`).join("")}
  </fieldset>
  <div class="row"><a class="btn sec" href="#summary/${p.id}">View summary</a><button class="btn" id="done" type="button">Mark complete and send</button></div>`;

  const drawSteps = focusSel => {
    $("#steps").innerHTML = p.steps.map((s, i) => `<li class="step"><div class="step-top"><span class="step-n">${i + 1}.</span><span>${esc(s.t)} <span class="muted">(${s.m} min)</span></span></div>
     <div class="step-actions"><button class="btn sec small" type="button" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move step ${i + 1} up">Up</button>
     <button class="btn sec small" type="button" data-dn="${i}" ${i === p.steps.length - 1 ? "disabled" : ""} aria-label="Move step ${i + 1} down">Down</button>
     <button class="btn danger small" type="button" data-rm="${i}" aria-label="Remove step ${i + 1}">Remove</button></div></li>`).join("");
    $("#tot").textContent = totalMinutes(p);
    $("#steps").querySelectorAll("button").forEach(b => b.onclick = () => {
      if (b.dataset.up) { const i = +b.dataset.up; moveStep(p, i, -1); touch(p, `Step moved to position ${i}.`); drawSteps(`[data-up="${i - 1}"]`); }
      if (b.dataset.dn) { const i = +b.dataset.dn; moveStep(p, i, +1); touch(p, `Step moved to position ${i + 2}.`); drawSteps(`[data-dn="${i + 1}"]`); }
      if (b.dataset.rm) { const i = +b.dataset.rm; const t = p.steps[i].t; p.steps.splice(i, 1); touch(p, `Removed step: ${t}.`); drawSteps(); $("#steps-h").focus(); }
    });
    if (focusSel) { let f = $("#steps " + focusSel); if (!f || f.disabled) f = $("#steps button:not([disabled])"); f && f.focus(); }
  };
  $("#steps-h").tabIndex = -1; drawSteps();

  for (const k of ["title", "date", "safety", "incl"]) {
    $("#" + k).addEventListener("input", e => { p[k] = e.target.value; touch(p); });
    $("#" + k).addEventListener("change", () => touch(p, ""));
  }
  CAT.categories.forEach((_, i) => $("#c" + i).addEventListener("input", () => { p.counts = sanitiseCounts(CAT.categories.map((_, j) => $("#c" + j).value)); touch(p); }));

  $("#add").onclick = () => {
    const t = $("#ns").value.trim(), m = parseInt($("#nm").value, 10);
    if (!t || !(m > 0)) { $("#ns-err").innerHTML = `<p class="err">Enter what happens and a number of minutes above 0.</p>`; (!t ? $("#ns") : $("#nm")).focus(); return; }
    $("#ns-err").innerHTML = ""; p.steps.push({ t, m }); $("#ns").value = ""; $("#nm").value = ""; touch(p, `Step ${p.steps.length} added.`); drawSteps(); $("#ns").focus();
  };

  $("#done").onclick = async () => {
    for (const k of ["title", "date", "steps", "safety", "incl"]) { $("#" + k + "-err").innerHTML = ""; const el = $("#" + k); el && el.removeAttribute("aria-invalid"); }
    const errs = markComplete(p);
    if (errs.length) {
      const target = f => f === "steps" ? "#ns" : "#" + f;
      errs.forEach(({ field, msg }) => { const el = $("#" + field); if (el && field !== "steps") el.setAttribute("aria-invalid", "true"); $("#" + field + "-err").innerHTML = `<p class="err">${msg}</p>`; });
      $("#es").innerHTML = `<div class="errsum" role="alert" tabindex="-1" id="esb"><h2>Finish ${errs.length} thing${errs.length > 1 ? "s" : ""} before sending</h2><ul>${errs.map(({ field, msg }) => `<li><a href="${target(field)}" data-f="${target(field)}">${msg}</a></li>`).join("")}</ul></div>`;
      $("#es").querySelectorAll("[data-f]").forEach(l => l.onclick = e => { e.preventDefault(); $(l.dataset.f).focus(); });
      await flushDraft(); $("#esb").focus(); return;
    }
    dirty = null; clearTimeout(saveTimer);
    await store.put(p);
    say("Plan complete. " + (offline() ? "It will send when there is signal." : "Sending now."));
    go("#plans"); kick();
  };
}

function summary(id) {
  const p = store.get(id); if (!p) return go("#plans");
  const a = act(p.act);
  $("#main").innerHTML = `<p class="noprint"><a class="back" href="#plans">Back to my plans</a></p><h1>${esc(p.title)}</h1>
  <p>${chip(p)}</p><p class="meta">${esc(a.name)} · ${esc(p.date || "date not set")} · ${totalMinutes(p)} minutes</p>
  <h2>Steps</h2><ol>${p.steps.map(s => `<li>${esc(s.t)} (${s.m} min)</li>`).join("")}</ol>
  <h2>Prepare beforehand</h2><ul>${a.mat.map(m => `<li>${m}</li>`).join("")}</ul>
  <h2>Safety</h2><div class="notice warn"><span aria-hidden="true">⚠ </span>${esc(p.safety) || "<em>Not written yet.</em>"}</div>
  <h2>Inclusion</h2><p>${esc(p.incl) || "<em>Not written yet.</em>"}</p>
  <h2>Participation</h2><table><caption class="sr">Participation counts by group</caption><thead><tr><th scope="col" style="text-align:left">Group</th><th scope="col" style="text-align:right">Count</th></tr></thead><tbody>${CAT.categories.map((c, i) => `<tr><th scope="row" style="text-align:left;font-weight:400;padding-right:2rem">${c}</th><td style="text-align:right">${p.counts[i]}</td></tr>`).join("")}</tbody></table>
  <div class="row noprint"><button class="btn sec" type="button" id="print">Print on A4</button>
  ${p.state === "COMPLETE" ? `<button class="btn sec" id="reopen" type="button">Edit plan</button>` : `<a class="btn" href="#edit/${p.id}">Continue editing</a>`}</div>
  ${p.state === "COMPLETE" ? `<p class="hint">Editing a sent plan turns it back into a draft. Mark it complete again to send the change.</p>` : ""}`;
  $("#print").onclick = () => window.print();
  const r = $("#reopen"); if (r) r.onclick = async () => { reopen(p); await store.put(p); go("#edit/" + p.id); };
}

function conflict(id) {
  const p = store.get(id); if (!p || p.sync !== "CONFLICT") return go("#plans");
  const s = p.serverCopy, changed = diffFields(p, s);
  const steps = v => `<ol>${v.map(x => `<li>${esc(x.t)} (${x.m} min)</li>`).join("")}</ol>`;
  const rows = [["date", "Date", v => esc(v)], ["steps", "Steps", steps], ["safety", "Safety notes", v => esc(v)]];
  $("#main").innerHTML = `<p><a class="back" href="#plans">Back to my plans</a></p><h1>Choose a version</h1>
  <div class="notice good"><strong>Nothing has been overwritten.</strong> The outreach unit changed “${esc(p.title)}” after you last sent it. Pick which copy to keep.</div>
  ${rows.map(([k, lbl, f]) => `<p class="${changed.includes(k) ? "changed" : ""}">${lbl}</p><div class="cols"><div class="ver"><h3>This phone</h3>${f(p[k])}</div><div class="ver"><h3>Outreach unit</h3>${f(s[k])}</div></div>`).join("")}
  <div class="row"><button class="btn" id="kl" type="button">Keep this phone's version</button><button class="btn sec" id="ks" type="button">Use outreach unit copy</button><a class="btn sec" href="#plans">Decide later</a></div>
  <p class="hint">Decide later keeps the plan usable on this phone; it just won't be sent yet.</p>`;
  $("#kl").onclick = async () => { await engine.keepLocal(p.id); say("Keeping this phone's version. It will be sent again."); go("#plans"); kick(); };
  $("#ks").onclick = async () => { await engine.useServer(p.id); say("Outreach unit copy kept. Plan is up to date."); go("#plans"); };
}

/* ---------- sync loop ---------- */
async function kick() {
  if (!engine || offline()) return;
  const out = await engine.runOnce();
  for (const { id, result } of out) {
    const t = store.get(id)?.title || "Plan";
    if (result === "synced") say(t + " sent to the outreach unit.");
    if (result === "conflict") say(t + ": the outreach unit changed this plan. Nothing was overwritten. Choose a version.");
    if (result === "failed") say("Could not send " + t + " after 3 tries. It is safe on this phone. Use Retry sending.");
    if (result === "rejected") say(t + " was refused by the server. Open it and check every field.");
  }
  refreshIfList();
  if (out.some(o => o.result === "retry")) setTimeout(kick, 1500);
}
function refreshIfList() {
  const r = location.hash.slice(1).split("/")[0];
  if (r === "plans" && store?.unlocked) { plansView(); }
  renderChrome(r);
}

/* ---------- test controls ---------- */
function wireTools() {
  const msg = t => ($("#t-msg").textContent = t);
  document.querySelectorAll("[name=net]").forEach(r => r.onchange = () => {
    simOffline = r.value === "offline";
    try { localStorage.setItem("stemmate.simOffline", simOffline ? "1" : "0"); } catch {}
    say(simOffline ? "No signal. Your plans are safe on this phone." : "Back online."); renderChrome(); kick();
  });
  $("#t-fail").onclick = async () => { try { await fetch("/api/_test/fail?count=3", { method: "POST" }); msg("The next 3 sends will fail with a server error."); } catch { msg("Server not reachable."); } };
  $("#t-edit").onclick = async () => {
    const p = store?.unlocked && store.list().find(x => x.sync === "SYNCHRONISED");
    if (!p) return msg("Sign in and send a plan first.");
    const r = await fetch(`/api/outreach/plans/${p.id}/edit`, { method: "POST" }).catch(() => null);
    if (!r || !r.ok) return msg("Server not reachable.");
    msg(`Outreach unit edited “${p.title}”. Edit and resend it on the phone to see the conflict.`);
  };
  $("#reset").onclick = () => { if (!confirm("Delete all STEMMate data on this phone?")) return; try { Object.keys(localStorage).filter(k => k.startsWith("stemmate.")).forEach(k => localStorage.removeItem(k)); } catch {} location.hash = ""; location.reload(); };
  $("#theme").onclick = () => { const d = document.documentElement; const dark = d.dataset.theme === "dark" || (!d.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches); d.dataset.theme = dark ? "light" : "dark"; };
}

boot();
