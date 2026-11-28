# GeoZipTag app: redeem a code, verify the signed entitlement, hide the banner (frontend)

Repository `SoHum-Digital-Services/GeoZipTag`, branch `step/geoziptag-app-pro` from `main`. Builder: the cloud GeoZipTag session (it owns all app work) or a fresh Claude Code step session. Status: not started. Written 2026-11-28 by Desk · GeoZipTag. This desk edits no app code; this brief is for whoever builds it.

**Pinned contract:** `sohum-contracts` at commit `0a2a17c` (entitlement shape 0.1.1). Build against that commit only.

## Opening prompt

```
Read docs/briefs/GEOZIPTAG_APP_frontend.md in this repo and sohum-contracts at commit 0a2a17c (docs/GEOZIPTAG_ENTITLEMENT_SHAPE.md and the schemas and examples it lists), and do part 1 only. Branch from main. The service does not exist yet: build against the contract's example payloads and a test key. Collect no new personal data. Stop and write docs/geoziptag-app/QUESTIONS.md if anything is ambiguous.
```

## Read only these

- `sohum-contracts`: `docs/GEOZIPTAG_ENTITLEMENT_SHAPE.md` (2 to 5, 8); `schemas/sohum-geoziptag-entitlement.schema.json` (`payload`, `signed`, `public_keys`, `redeem_request`, `check_request`) and the matching examples in `schemas/examples/` (`...entitlement-payload`, `...entitlement-signed`, `...public-keys`, `...redeem-request`, `...check-request`).
- In this repo: `STATUS.md`; `web/camera.js` (search "Banner ad (apps only)": `adHost`, `adShown`, `syncAd`, the `adShow`/`adHide` bridge calls); `web/index.html` (`dialog#settings`); `web/privacy.html`; `tools/ota/README.md` and `android/app/src/main/java/com/geostampcam/mobile/OtaUpdater.java` (`WEB_PATH`).

## Facts that shape the build

- **No new web file can be added.** The app serves, and an update may contain, only the files in `OtaUpdater.WEB_PATH` (`index.html`, `style.css`, `camera.js`, vendor and asset names). A new `.js` or `.json` file would need a native build. So **all code goes in `camera.js`, `index.html` and `style.css`**, and the public key set is a constant inside `camera.js`. Part 1 therefore needs **no native change** and ships as a web update (preview channel first).
- The banner is drawn by the native shell when the page calls `adHost.adShow(...)`. Hiding it needs only the page to stop calling `adShow` and to call `adHide()` (already done in `syncAd`).
- The app is English only (`<html lang="en">`); match the existing wording style. Telugu is not part of this step.
- The service does not exist yet and the examples' signature and public key in the contract are **placeholders**, so a real verification cannot pass on them. Tests generate their own ES256 test keypair in the test (never committed as a "real" key) and sign the example payload with it.

## What to build (part 1: codes, trials and admin grants; device-based)

1. **Device identity.** On first use make a random UUID (`crypto.randomUUID()`), keep it in `localStorage` (key `geoziptagInstallId`). It is not a hardware, advertising, phone or account id, is never sent anywhere except the entitlement calls, and is never joined to a team register entry. Clearing app data makes a new one (Pro is then lost; this is the accepted device-based model).
2. **Redeem code row** in Settings (`dialog#settings`): a row "Redeem code" opening a small sheet with a text field, a Redeem button and a status line. Normalise nothing in the app beyond trimming; the server ignores case, spaces and hyphens. Call `redeem_code` (`POST <base>/geoziptag-actions/redeem_code`, body `{ install_id, code }`, base URL a constant). Outcomes in plain English: success ("Ads are off until <date>"), the single generic failure for a bad, expired or used-up code ("This code can't be used"), a rate-limit message (429), and an offline or server-error message ("Couldn't reach SoHum. Try again."). Never say which of the failure reasons applied.
3. **Store and verify.** The reply is `sohum.geoziptag.entitlement.signed/1`. Verify before storing: look up `key_id` in the bundled `public_keys` constant (unknown id: reject); `crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSignature, payloadBytes)` with the public key imported as SPKI (the signature is raw `r||s`, which is what WebCrypto expects); only then parse the payload. Check `subject.kind === 'install'` and `subject.id` equals this phone's install id, `plan === 'pro'`, `schema` as expected. Store the verified envelope in `localStorage` (`geoziptagEntitlement`). Never trust an unverified response and never store one.
4. **Is Pro on?** A pure function `entitled(now)`: true only if a stored, verified payload has `enabled`, `now >= starts_at`, and `now < ends_at` (null: no end) **and** `now < grace_until`. Re-verify the signature when loading from storage (storage can be edited).
5. **Daily re-check.** On launch and when the app returns to the foreground, if `now >= check_after` (or there is nothing stored but the install has ever redeemed), call `check_entitlement` (`POST .../check_entitlement`, body `{ install_id }`) and handle it as in step 3. `data: null` means no entitlement. A failed call (offline, 5xx) changes nothing: the stored entitlement keeps working until `grace_until` (about 7 days after the last good check, never past `ends_at`), then the banner returns. A verified reply with `enabled: false` or a past `ends_at` takes effect at once.
6. **Hide the banner when entitled.** In `syncAd`, treat an entitled phone as "no ad": `slot.hidden = true`, call `adHide()` if shown, never call `adShow`. Re-evaluate when the entitlement changes and on the daily timer, so the banner returns by itself when Pro ends. Nothing else in the app is gated: the camera, stamping, attendance and the team register never lock. If `crypto.subtle` is unavailable or anything throws, fail soft: the banner stays as it is today.
7. **Privacy page.** Update `web/privacy.html`: a short section saying the app makes a random install id, sends it with a code you type or a once-a-day check to SoHum, that SoHum keeps the code you redeemed and when, nothing else (no name, location, advertising id or contact detail), and that the Ads section changes only in that a paid or code entitlement stops the banner. Wording is the owner's to approve.
8. **No other collection.** No government identifier, no phone number, no email, no account, no sign-in in part 1.

## Feature flag (so nothing reaches phones before the service exists)

Everything above sits behind one constant `ENTITLEMENTS_LIVE = false`. While it is `false` the Redeem row is hidden and no network call is made, and the app behaves exactly as today. Merge to `main` (which goes live to every installed app by the wireless update) only with the flag `false`; test on a non-`main` branch, which publishes to the preview channel only. The owner flips the flag, in a separate pull request, after the service is deployed and the console checklist in `GEOZIPTAG_SERVICE_backend.md` is done.

## Acceptance tests (supplied; keep in the repo, do not weaken)

Plain Node tests under `tools/entitlement/test/` (`node --test`), loading the entitlement block out of `camera.js` between marker comments (`// ---- Entitlement (start)` / `(end)`) with `node:vm`, so the real code is what is tested. Test keypair generated inside the test.

| # | Test | Expected |
|---|---|---|
| E1 | The contract's example payload signed with the test key verifies; one flipped payload byte, a wrong `key_id`, a signature from another key | accept, reject, reject, reject |
| E2 | `entitled()` before `starts_at`, inside, after `ends_at`, `enabled:false`, after `grace_until` while offline | false, true, false, false, false |
| E3 | Stored entitlement edited in storage (payload or signature changed) | not entitled |
| E4 | `subject.id` of another install; `plan` other than `pro`; unknown `schema` | rejected |
| E5 | Daily check: a failed call keeps the stored entitlement until grace ends; `data: null` clears it; `enabled:false` reply turns Pro off at once | pass |
| E6 | `syncAd` with an entitled phone never calls `adShow` and calls `adHide` if shown; when entitlement lapses it shows again | pass |
| E7 | `ENTITLEMENTS_LIVE = false`: no network call, Redeem row hidden, behaviour unchanged | pass |
| E8 | A redeem reply is shown with the generic message for 422, a rate-limit message for 429, an offline message when the request fails; no response text is displayed verbatim | pass |

## Done when

```
node --test tools/entitlement/test/
bash tools/ota/test/run.sh          # the existing update tests still pass
```

plus the existing browser checks the cloud session already runs (stamp timing, sheets), re-run on the Settings dialog because it changes. One pull request on a non-`main` branch. No native change, so no `ota-min-apk.txt` change and no new build.

## Part 2 (later, a separate brief after the service's team steps): team plans and sign-in

Only for team plans and memberships: SoHum sign-in, `join_team` with the team's existing code, and sending the bearer token with `check_entitlement` so a team's plan applies and a removed member loses it at the next check. The derived team entitlement has `subject.kind: 'account'`, so the app checks the subject against the signed-in account id, not the install id. **Open question for HQ and the owner before this brief is written:** how the app signs in to SoHum. The app has no sign-in today, and Google refuses sign-in inside an embedded web view, so the usual route is the system browser, which is native work on both phones (and a new build). Do not start part 2 until that is decided.

## Part 3 (later): store billing

StoreKit and Play Billing, `check_request.store_receipt`, and a restore-purchases path. Not part of any step above.

## Not verified (say so in the report)

Real verification against the real service and key; that `crypto.subtle` ECDSA is available in the Android WebView and the iPhone web view in the way the app loads its pages (check on both and report; if it is not, stop and write `QUESTIONS.md`, do not add a hand-written crypto library without asking); the preview-channel behaviour on a real phone; the final privacy wording; store review impact (none expected for a code that only removes an ad, but not checked).

## Report (commit as `docs/geoziptag-app/REPORT.md`)

```
Step:            GeoZipTag app part 1, frontend
Contract pin:    0a2a17c
Built:           what, one line each (files: camera.js, index.html, style.css, privacy.html, tests)
Tests:           commands run and result; checks not run and why
Not done:        ...
Deviations:      ...
Questions:       none | see QUESTIONS.md
Flag:            ENTITLEMENTS_LIVE = false (confirm)
```

## Order of work

1. Entitlement block in `camera.js` (install id, verify, `entitled`, storage) with tests E1 to E4. 2. Daily check and grace (E5). 3. `syncAd` change (E6). 4. Flag (E7). 5. Settings row and sheet, messages (E8). 6. Privacy page. 7. Re-run the existing checks.
