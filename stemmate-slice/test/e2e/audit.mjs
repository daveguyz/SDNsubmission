// End-to-end accessibility and recovery audit (tests MT-A1…A6 in the report).
// Drives the real app in headless Chrome against a fresh server, runs axe-core on
// every key state, scans target sizes, checks 320 px reflow and records screenshots.
// Usage: node test/e2e/audit.mjs [outDir]    (CHROME_PATH overrides the browser path)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
import { createServer } from "../../server/server.js";

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const OUT = path.resolve(process.argv[2] || "audit-out");
fs.mkdirSync(path.join(OUT, "screens"), { recursive: true });
const CHROME = process.env.CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => fs.existsSync(p));

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stemmate-audit-")), "plans.json");
const server = createServer({ dbFile });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = { date: new Date().toISOString(), chrome: await browser.version(), axe: "4.10.2", states: [], reflow: null, tabOrder: null, focusVisible: null };

async function audit(name, file) {
  await page.addScriptTag({ content: AXE });
  const axe = await page.evaluate(async () => {
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return { violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), passes: r.passes.length };
  });
  const small = await page.evaluate(() => [...document.querySelectorAll("button,a[href],input,select,textarea")]
    .filter(e => e.offsetParent !== null && !e.closest(".tools"))
    .map(e => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ e, r }) => (r.width < 24 || r.height < 24) && !(e.tagName === "A" && e.closest("p,li") && !e.classList.contains("btn") && !e.classList.contains("back")))
    .map(({ e, r }) => `${e.tagName.toLowerCase()}#${e.id || ""} "${(e.innerText || e.value || "").slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`));
  if (file) await page.screenshot({ path: path.join(OUT, "screens", file + ".png") });
  results.states.push({ name, axeViolations: axe.violations, axePasses: axe.passes, undersizedTargets: small });
  console.log(`${name.padEnd(34)} axe violations: ${axe.violations.length}  undersized targets: ${small.length}`);
}
const click = sel => page.$eval(sel, e => e.click());
const type = async (sel, v) => { await page.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); }, v); };

try {
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await page.waitForSelector("#pin");
  await audit("S1 Sign in", "s1_signin");
  await type("#pin", "0000"); await click("#go"); await page.waitForSelector("#pin-err .err");
  await audit("S1 Wrong PIN error", "s1_pin_error");
  await type("#pin", "1234"); await click("#go"); await page.waitForFunction(() => location.hash === "#plans");
  await audit("S2 My plans (empty)", null);
  await page.evaluate(() => (location.hash = "#catalogue")); await sleep(200);
  await page.$$eval("[name=m]", els => els.filter(e => ["Vinegar", "Baking soda", "Paper cups"].includes(e.value)).forEach(e => (e.checked = true)));
  await page.$eval("#ff", f => f.requestSubmit()); await sleep(200);
  await page.$eval("#res-h", e => e.scrollIntoView()); await audit("S3 Find activity – results", "s3_results");
  await page.evaluate(() => (location.hash = "#activity/a3")); await sleep(200);
  await audit("S4 Activity detail", "s4_activity");
  await click("#mk"); await page.waitForFunction(() => location.hash.startsWith("#edit/"));
  await audit("S5 Plan editor", "s5_editor");
  await click("#done"); await page.waitForSelector("#esb");
  await page.evaluate(() => window.scrollTo(0, 0));
  await audit("S6 Validation error summary", "s6_validation");
  // focus visibility on the editor
  results.focusVisible = await page.evaluate(() => {
    const els = [...document.querySelectorAll("#main button:not([disabled]),#main a[href],#main input,#main textarea")];
    return els.map(e => { e.focus(); const cs = getComputedStyle(e); return { el: e.id || e.innerText.slice(0, 20), outline: cs.outlineStyle + " " + cs.outlineWidth }; })
      .filter(x => !x.outline.startsWith("solid 3px"));
  });
  await type("#date", "2026-11-12"); await type("#incl", "Let learners describe it in a home language first.");
  await page.evaluate(() => { localStorage.setItem("stemmate.simOffline", "1"); document.querySelector("#net-off").click(); });
  await click("#done"); await page.waitForFunction(() => location.hash === "#plans"); await sleep(300);
  await audit("S2 Offline – waiting for signal", "s2_offline_pending");
  await page.evaluate(() => fetch("/api/_test/fail?count=3", { method: "POST" }));
  await page.evaluate(() => { localStorage.setItem("stemmate.simOffline", "0"); document.querySelector("#net-on").click(); });
  await page.waitForSelector("[data-retry]", { timeout: 15000 });
  await audit("S2 Sync failed with Retry", "s2_failed");
  await click("[data-retry]"); await page.waitForFunction(() => document.body.innerText.includes("Sent to outreach unit"), { timeout: 10000 });
  await audit("S2 Sent", "s2_sent");
  const id = await page.$eval(".item h3 a", a => a.getAttribute("href").split("/")[1]);
  await page.evaluate(id => fetch(`/api/outreach/plans/${id}/edit`, { method: "POST" }), id);
  await page.evaluate(id => (location.hash = "#summary/" + id), id); await sleep(200);
  await audit("S7 Plan summary", "s7_summary");
  await click("#reopen"); await page.waitForSelector("#ns");
  await type("#ns", "Wipe tables and wash cups"); await type("#nm", "5"); await click("#add"); await sleep(200);
  await click("#done"); await page.waitForFunction(() => document.body.innerText.includes("Needs your choice"), { timeout: 10000 });
  await audit("S2 Conflict flagged", "s2_conflict");
  await page.evaluate(id => (location.hash = "#conflict/" + id), id); await sleep(200);
  await audit("S8 Choose a version", "s8_conflict");
  await page.evaluate(id => (location.hash = "#summary/" + id), id); await sleep(100);
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark")); await sleep(100);
  await audit("S7 Summary – dark mode", "s7_summary_dark");
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));

  // Reflow at 320 CSS px (WCAG 1.4.10)
  await page.setViewport({ width: 320, height: 640, deviceScaleFactor: 2 });
  await page.evaluate(() => (location.hash = "#catalogue")); await sleep(300);
  results.reflow = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  await page.screenshot({ path: path.join(OUT, "screens", "reflow_320.png") });
  console.log("Reflow 320px:", results.reflow);

  // Keyboard tab order on My plans (WCAG 2.4.3)
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2 });
  await page.evaluate(() => (location.hash = "#plans")); await sleep(300);
  const order = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); order.push(await page.evaluate(() => { const a = document.activeElement; return (a.innerText || a.value || a.id || a.tagName).trim().slice(0, 40); })); }
  results.tabOrder = order;
  console.log("Tab order:", order.join(" → "));
  console.log("Controls without 3px focus outline:", results.focusVisible.length);
} finally {
  fs.writeFileSync(path.join(OUT, "a11y-audit.json"), JSON.stringify(results, null, 2));
  await browser.close();
  server.close();
}
