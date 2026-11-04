# STEMMate Namibia – A4 vertical slice (v1.3)

One priority workflow, end to end: **a facilitator plans a session offline, marks it complete,
and the plan is delivered to the outreach unit when signal returns** (FR-03 to FR-07, QR-01 to QR-03).
UI → validation → domain logic → encrypted storage on the phone → sync API → persistent file on the server → visible status.

Synthetic data only. No real names, learners or schools.

## Requirements
- Node.js 20 or newer (tested on Node 24.19.0, Windows 11). No runtime dependencies.
- Any current Chrome, Edge or Firefox.
- Dev only: `puppeteer-core` and `axe-core` for the accessibility audit (installed by `npm install`).

## Set up and run (clean machine)
```
npm install          # dev tools only; the app itself needs none
npm start            # http://localhost:8080   (PORT=xxxx to change)
```
Sign in as **Selma (demo), PIN 1234** or **Johannes (demo), PIN 5678**.
The panel beside the phone is test controls only: simulated offline, 3 injected server
errors and an outreach-unit edit (for the conflict). Set `TEST_CONTROLS=0` to disable them.

## Tests
```
npm test                                  # 18 automated unit + integration tests (node:test)
node test/e2e/audit.mjs ../test-evidence/audit   # axe-core WCAG 2.2 AA audit, target sizes, 320 px reflow, screenshots
```
`CHROME_PATH` can point the audit at a different Chrome/Edge binary.

## Demo script (about 3 minutes of the briefing)
1. Sign in with a wrong PIN → error names the facilitator; then PIN 1234.
2. Find activity → tick Vinegar, Baking soda, Paper cups → 1 activity → Plan a session with this.
3. Mark complete and send with gaps → error summary, focus moves, fields marked.
4. Add date and inclusion prompt. Test controls → Offline. Mark complete → "Waiting for signal".
5. Server fails next 3 sends → Online → "Not sent – tap Retry" → Retry sending → "Sent to outreach unit".
6. Outreach unit edits my last sent plan → open the plan → Edit plan → add a step → send → "Needs your choice"
   → Keep this phone's version → sent.

## Structure
| Path | Purpose |
|---|---|
| `src/core.js` | Domain rules shared by phone and server (filter, validation, data minimisation) |
| `src/store.js` | AES-256-GCM vault per facilitator, PBKDF2 key from PIN, lock on sign-out |
| `src/sync.js` | Conditional PUT, idempotent replay, retry ×3, conflict resolution |
| `src/ui.js` | Screens, autosave, live announcements |
| `server/server.js` | Sync API + static files; stores plans in `server/data/plans.json` |
| `data/*.json` | Catalogue and interface labels the outreach unit edits without code changes (SR-01) |
| `public/` | HTML shell, CSS, service worker, manifest; `prototype-v1.2.html` is the A3 baseline for comparison |
| `test/` | Automated tests; `test/e2e/audit.mjs` accessibility audit |

## Known limitations
- Demo PINs are 4 digits; PBKDF2 slows guessing but does not stop an attacker who copies the phone storage. Production needs 6+ digit PINs and an attempt limit.
- No real authentication on the server; TLS 1.3 is provided by the reverse proxy in deployment, not by `server.js`.
- Keystrokes typed in the last second before the browser is killed can be lost (autosave debounce 1 s; FR-04 allows 2 s).
- Not tested on a physical low-spec Android phone or with a screen reader by an experienced user.
- Single-file JSON store suits one outreach unit (hundreds of plans), not national scale.

## Licence
MIT for the code. Atkinson Hyperlegible font: SIL Open Font License (loaded from Google Fonts in v1.2 prototype only).
