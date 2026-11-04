# Manual and browser checks – 4 November 2026

Environment: Windows 11, Node 24.19.0, Chrome (headless via puppeteer-core 23.11.1) and the Claude desktop in-app browser, server on localhost.

| ID | Check | Steps | Result |
|---|---|---|---|
| MT-01 | Wrong PIN (QR-03, WCAG 3.3.1) | PIN 9999 for Selma | Error "That PIN does not match Selma (demo)…", aria-invalid=true, focus returned to PIN. PASS |
| MT-02 | Validation summary (FR-03, WCAG 3.3.1/3.3.3) | New plan → Mark complete | "Finish 2 things before sending: Add the session date. Write an inclusion prompt." Focus on summary; date and incl aria-invalid. PASS |
| MT-03 | Autosave on quick navigation – v1.2 prototype (FR-04) | Type in Inclusion, leave editor after 0.5 s, wait 2.6 s | Text NOT saved; console "Uncaught TypeError: Cannot read properties of null (reading 'value')". FAIL (baseline, issue I-02) |
| MT-04 | Same as MT-03 on slice v1.3 | Same steps, then reload page and sign in again | Text present after reload, no console errors. PASS |
| MT-05 | Drafts at rest – v1.2 prototype (QR-03) | Inspect localStorage | Plan titles stored in plain text ("Okahandja" found). FAIL (baseline, issue I-03) |
| MT-06 | Drafts at rest – slice v1.3 | Inspect localStorage after editing | Plan text not found in storage. PASS |
| MT-07 | Offline queue (FR-06, FR-07) | Offline → complete plan | Chip "Waiting for signal"; banner "No signal… 1 waiting to send." PASS |
| MT-08 | 3 server errors + Retry (FR-06, FR-07) | Inject 3 failures → Online | "Not sent – tap Retry" + message; Retry → "Sent to outreach unit". PASS. Banner said "Sending 1 plan…" while failed → issue I-05, fixed, re-run PASS |
| MT-09 | Conflict (FR-06) | Outreach edit → reopen, add step, send | "Needs your choice"; Choose a version shows "Nothing has been overwritten", CHANGED: Steps, Safety notes. Keep this phone's version → sent, server rev 3 contains phone step. PASS |
| MT-10 | Accessibility audit (QR-02) | `node test/e2e/audit.mjs` | 14 states, 0 axe violations, 0 undersized targets, 320 px reflow scrollWidth 320, all controls 3 px focus outline. PASS |
| MT-11 | Keyboard order (WCAG 2.4.3) | Tab ×6 on My plans | Plan link → conflict link → Find an activity → nav → test controls. PASS |
