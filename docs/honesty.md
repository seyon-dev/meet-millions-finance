# What is real, and what is not

The brief for this system forbade placeholders: no dead navigation, no fake
charts, no "Coming Soon", no simulated API success, no invented payment
confirmations, no pretend persistence. This document is how that claim is kept
checkable rather than asserted.

## What "real" means here

| Claim | How it is held |
| --- | --- |
| Every screen reads the real API | No screen contains fixture data. The build check fails on a route whose screen file is missing, and `npm run ui-check` walks 55 of the 73 registered routes in a real browser, at four widths, as three different people — an admin, a platform Super Admin and a client — reporting console errors, failed requests, horizontal overflow and stuck skeletons. The 18 it does not walk are the ten that need a record id (`/clients/:id`), the six sign-in and password screens, and two role dashboards that need a session of their own. |
| Every API route reads and writes D1 | 114 tests run the real Worker against real migrations on a `node:sqlite` D1 stand-in. |
| No dead navigation | The build check resolves every internal link against the routes the SPA registers. It fails on a path nothing serves. |
| No fake permission checks | The build check fails on any permission key not in the catalogue. |
| No fake vendor success | Every provider returns `not_configured` with its missing keys named. Tests assert that the calling endpoints surface that, rather than fabricating a result. |
| No fake payment confirmation | An invoice is marked paid by a signature-verified webhook. A gateway that has accepted but not confirmed resolves as `pending`. |
| Charts are drawn from data | Inline SVG generated from the response. There are no chart images. |
| QR codes scan | `core/qr.js` is a real ISO/IEC 18004 encoder, tested against checked-in reference matrices for versions 1, 4, 6, 7 and 10, and by decoding its own output. |

## Demonstration data

`npm run dev` seeds an invented practice — Meridian Tax Associates — with five
invented client companies. Every record is flagged `is_demo`, the tenant is
marked as a demonstration, and the interface shows a banner saying so on every
screen. The seeded PDFs say "DEMONSTRATION DATA" on their face in 20pt.

None of it is real, and none of it is anybody's real business. A demo that is
indistinguishable from production is how somebody ends up filing it.

## What is not built

Listed because leaving it out would be the dishonest part.

### Needs credentials to do anything

These are complete in code — adapter, endpoints, screens, error handling — and
do nothing on a deployment with no keys, which they report rather than fake:

- OCR, the AI assistant, AI insights and AI document verification (Google
  Vision, Claude API)
- Voice-note transcription (Google Speech)
- Outbound email, SMS, WhatsApp and push
- Lead capture from Meta Lead Ads, Google Sheets and Google Forms
- Calendar sync, cloud-storage sync, e-Sign
- Live calling, and the whole cloud telephony module
- Taking an actual payment

### Not implemented

- **A virus scanner.** The *integration* is implemented and the upload path
  uses it: an infected file is refused before it reaches R2, and
  `scan_status` records `skipped`, `clean`, `infected` or `failed` from what
  actually happened. But no scanner ships in this repository. Until
  `VIRUS_SCAN_URL` points at one, every upload is recorded `skipped`, which
  means unscanned.
- **Off-database audit anchoring.** The nightly anchor now detects tail
  truncation, which the bare chain could not. The anchors are stored in the
  same database, so somebody with write access to both tables can rewrite them
  to match. Writing the head hash to an append-only store outside this
  deployment is not done.
- **The mobile application.** Add-on 18 is a native app. The API it needs
  exists — push registration, device sessions, attendance with GPS — but no
  Android or iOS client is in this repository, and the add-on links to no screen
  because there is none to link to.
- **Automated visual regression.** `npm run ui-check` catches console errors,
  failed requests, overflow and stuck skeletons. It does not compare
  screenshots, so a layout that renders cleanly but wrongly needs a person to
  look at it.
- **GSTN filing.** Returns are computed, reconciled and produced as reports;
  nothing files them with the GST portal. There is no GSTN API integration.

### Deliberately narrow

- **Reconciliation** matches on GSTIN, invoice number, date window and amount
  tolerance. It does not do fuzzy name matching.
- **The analytics builder** composes the metrics the API exposes. It is not a
  general SQL query surface, on purpose.
- **Tax computation** covers GST (CGST/SGST/IGST, intra- and inter-state), and
  TDS at the rates in `data/tax-rules.js`. It is not a full income-tax engine.

## Checking these claims yourself

```bash
npm run build     # links, routes, permissions, CSS variables, icons, migrations
npm test          # 114 tests against the real Worker
npm run dev       # then npm run ui-check in another shell
```

If one of the claims in the first table stops being true, one of those three
commands is meant to fail. If it stops being true and they all still pass, the
check was not good enough — which is worth fixing before the claim is restated.
