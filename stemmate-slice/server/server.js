// STEMMate outreach-unit sync server (vertical slice). Node.js, no dependencies.
// Serves the app shell and stores completed plans in a JSON file (persistent data).
// Run: node server/server.js   ->  http://localhost:8080
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlan, hasOnlyWireFields, ID_PATTERN } from "../src/core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MAX_BODY = 500 * 1024; // QR-01: ≤ 500 KB per sync request
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json" };
const STATIC = { "/": "public/index.html", "/index.html": "public/index.html", "/style.css": "public/style.css", "/sw.js": "public/sw.js", "/manifest.webmanifest": "public/manifest.webmanifest", "/prototype-v1.2.html": "public/prototype-v1.2.html" };

export class FileDb {
  constructor(file) { this.file = file; this.data = { plans: {} }; this.load(); }
  load() { try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.data = { plans: {} }; } }
  save() { // write-then-rename so a crash never leaves a half-written file
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  get(id) { return this.data.plans[id] || null; }
  set(id, rec) { this.data.plans[id] = rec; this.save(); }
}

export function createServer({ dbFile = path.join(ROOT, "server", "data", "plans.json"), testControls = true, log = () => {} } = {}) {
  const db = new FileDb(dbFile);
  let failNext = 0;

  const send = (res, status, obj, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(obj));
  };
  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    log(req.method, p);
    try {
      // ---- API ----
      if (p === "/api/health") return send(res, 200, { ok: true });
      if (p === "/api/catalogue" && req.method === "GET")
        return send(res, 200, JSON.parse(fs.readFileSync(path.join(ROOT, "data", "catalogue.json"), "utf8")));

      let m = p.match(/^\/api\/plans\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!ID_PATTERN.test(id)) return send(res, 400, { error: "Invalid plan id" });
        if (req.method === "GET") { const r = db.get(id); return r ? send(res, 200, r) : send(res, 404, { error: "Not found" }); }
        if (req.method !== "PUT") return send(res, 405, { error: "Method not allowed" });
        if (failNext > 0) { failNext--; return send(res, 503, { error: "Service unavailable (injected)" }); }
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return e.code === 413 ? send(res, 413, { error: "Plan too large" }) : send(res, 400, { error: "Body is not JSON" }); }
        const plan = body?.plan, editId = String(body?.editId || "");
        if (!hasOnlyWireFields(plan) || plan.id !== id) return send(res, 400, { error: "Unexpected fields in plan" });
        const errs = validatePlan(plan);
        if (errs.length) return send(res, 422, { error: "Plan incomplete", fields: errs });
        const ifMatch = Number(req.headers["if-match"] ?? -1);
        const cur = db.get(id);
        // Idempotent replay: same editId already stored → return the stored revision, no duplicate.
        if (cur && editId && cur.lastEditId === editId) return send(res, 200, { rev: cur.rev, replay: true });
        const curRev = cur ? cur.rev : 0;
        if (cur && ifMatch !== curRev) return send(res, 412, { error: "Changed elsewhere", server: { ...cur.plan, rev: cur.rev, editedBy: cur.editedBy } });
        const rec = { plan, rev: curRev + 1, lastEditId: editId, editedBy: "facilitator", receivedAt: new Date().toISOString() };
        db.set(id, rec);
        return send(res, cur ? 200 : 201, { rev: rec.rev });
      }

      // Outreach-unit edit (simulates a second editor, used by tests and the demo).
      m = p.match(/^\/api\/outreach\/plans\/([^/]+)\/edit$/);
      if (m && req.method === "POST" && testControls) {
        const cur = db.get(decodeURIComponent(m[1]));
        if (!cur) return send(res, 404, { error: "Plan has not been received yet" });
        const plan = structuredClone(cur.plan);
        plan.steps.splice(Math.min(2, plan.steps.length), 0, { t: "Hand out safety goggles before mixing", m: 3 });
        plan.safety += " Goggles required for all learners (added by outreach unit).";
        db.set(plan.id, { ...cur, plan, rev: cur.rev + 1, lastEditId: "outreach", editedBy: "outreach unit" });
        return send(res, 200, { rev: cur.rev + 1 });
      }
      if (p === "/api/_test/fail" && req.method === "POST" && testControls) {
        failNext = Math.max(0, Math.min(10, Number(url.searchParams.get("count") || 3)));
        return send(res, 200, { failNext });
      }

      // ---- static files (whitelist + /src/*.js, /data/*.json) ----
      let rel = STATIC[p];
      if (!rel && /^\/src\/[a-z]+\.js$/.test(p)) rel = p.slice(1);
      if (!rel && /^\/data\/[a-z]+\.json$/.test(p)) rel = p.slice(1);
      if (!rel) return send(res, 404, { error: "Not found" });
      const file = path.join(ROOT, rel);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      send(res, 500, { error: "Server error" });
    }
  });
  server.db = db;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  createServer({ testControls: process.env.TEST_CONTROLS !== "0", log: (m, p) => console.log(new Date().toISOString(), m, p) })
    .listen(port, () => console.log(`STEMMate slice running at http://localhost:${port}`));
}
