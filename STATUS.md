# GeoZipTag status            updated 2026-11-28 by Desk · GeoZipTag (actions service live, app side not built)

Covers this repository (`SoHum-Digital-Services/GeoZipTag`, folder `GeoZipTag`; iOS and Android camera app, bundle `cc.sohum.geoziptag`). How this ledger works: `sohum-contracts` docs/OPERATING_MODEL.md. Facts below were read from the repository on 2026-11-28; nothing was run or deployed in this turn. "Not verified" means exactly that.

## Now
- **Live (owner ran every step, 2026-11-28, per HQ):** the actions service is deployed and the console talks to it. See "Actions service: live" and "Live" below. **Not built:** the app side (redeem screen, entitlement check, banner hiding), real phone redemption, paid store billing, team joining from the app.



- **Roles (HQ, 2026-11-28):** the cloud GeoZipTag session does all app work (iOS/Android code, in-app UI, AdMob). This desk keeps this ledger, the contract work (entitlement and redeem-code shapes, as a draft for a sohum-contracts PR) and console integration with Desk · Console, and reports to HQ. This desk edits no app code and nothing on the cloud session's branches; it cannot be messaged from HQ, so anything it needs is written here or in `docs/` and HQ relays it.
- **Owner decisions (relayed by HQ 2026-11-28, "yes, those defaults are fine"):** Pro removes the AdMob banner only. Codes and free offers are built first; individual paid Pro through Apple/Google billing is later and not in the first build (`source: paid` stays in the shape). A code can be used by several people up to a per-code limit (1 = single use), every redemption recorded. Device-based by default; SoHum sign-in only for team plans and memberships (members inherit the team's plan; removing a member removes their entitlement). Kept: signed entitlement, public-key check, daily re-check, ~7-day grace, propose then confirm, owner/operator only. Recorded in contracts#118 (updated).


## What exists (from the code)

- Main is at a9c4d9b (PRs #2 to #6 merged). New in the web app: Attendance area (Employees / Shifts / Register / Team), per-employee shifts, week offs and rotation, ON TIME / LATE / EARLY / WEEK OFF marks, Week Off style, flash button always visible, Android front-camera display flash (native 1.25). Employees, shifts and passport photos live in localStorage.
- Web app in `web/` (one copy, bundled into both phone apps and published to GitHub Pages): GPS photo/video stamp, satellite map, photo attendance with employee IDs and shifts, Week Off mode, reports.
- Android 1.25 (code 26) and iPhone 1.25 (build 26): native shells around `web/`. Signed wireless updates of `web/` (ECDSA P-256, public key bundled in the app; `tools/ota/`).
- Optional shared team register on the **`sohum` Supabase project** (`ziebgspujtdzkiwyybsa`): the app calls `rpc/geoziptag_*` functions and bucket `geoziptag-photos` with the publishable key; a team is a code plus a 6-digit manager PIN. **No user accounts, no device identity, no sign-in anywhere in the app.** Per the cloud session's handover (not re-verified by this desk): tables `geoziptag_teams` and `geoziptag_attendance` and functions `geoziptag_create_team / join / submit / list / team_folder` are in the **public** schema; that session applied a migration on 2026-11-28 (action `weekoff` allowed; nullable `shift`, `status`, `photo_kind`; `submit` and `list` updated; Week Off rows have GPS/place stripped server-side; verified with a rolled-back test). The migration files are not in this repository (not verified where they live); they should be committed here or to the console repo.
- Ads: one Google AdMob banner in the photo view on Android and iPhone, **Google test ad IDs only** until store listings exist (`android/app/build.gradle`, `ios/project.yml`). Always shown; there is no Pro, trial, coupon or entitlement concept in the code today.
- Privacy policy in `web/privacy.html` (says what the register stores; says nothing about entitlements).

## Actions service: live (2026-11-28, owner ran each step; facts from HQ, re-checked by none of this desk's own calls)

- Migration `supabase/migrations/0001_geoziptag_entitlements.sql` applied to project `sohum`: schema `geoziptag`, 9 tables, RLS on, no policies. Rollback: `supabase/rollbacks/0001_geoziptag_entitlements.down.sql`.
- Function `geoziptag-actions` deployed from GeoZipTag#7 (merged, `ec1e419`); `GET /health` returns `ok`, version 0.1.0. Base `https://ziebgspujtdzkiwyybsa.supabase.co/functions/v1`. 17 actions, manifest at `/geoziptag-actions/manifest`.
- Function secrets set: `GEOZIPTAG_SIGNING_KEY`, `GEOZIPTAG_SIGNING_KEY_ID` (`key-2026-11`), `GEOZIPTAG_PUBLIC_KEYS`, `GEOZIPTAG_CONSOLE_SECRET`, `GEOZIPTAG_CODE_PEPPER`. Private copies are in the owner's password manager; the public keys file is in `~/geoziptag-keys` on the owner's machine (the app needs the public half; it is not in this repo yet).
- `sohum-console-api` revision 00007 has the shared secret and `CONSOLE_ROLES` (owner only). Console screens are live (console-web #14, Worker `30c8e5b6`).
- Checked by HQ: the registry shows GeoZipTag up with 17 actions. The owner created a test code through the console (propose, confirm); it appeared in the code list and the audit log, then was disabled. DB afterwards: 1 code (enabled = false), 16 audit rows, 0 entitlements.
- Also settled by HQ: `public.geoziptag_teams` has `id` (uuid), `name`, `code`; the `sohum` project publishes an ES256 JWKS.

### Not built, not verified

- **App side not built:** nothing in `web/` knows about entitlements. No redeem screen, no signed-entitlement check, no daily re-check or grace, banner still always shown. The public key is not in the app. Brief: [docs/briefs/GEOZIPTAG_APP_frontend.md](docs/briefs/GEOZIPTAG_APP_frontend.md), behind a flag, not started.
- **No real phone redemption yet:** `redeem_code` and `check_entitlement` have not been called from a phone; 0 entitlements exist. Only the console's create-code path was exercised live.
- **Paid billing not built** (Apple/Google); `source: paid`/`store` stay in the shape.
- **Team joining not built:** `join_team` exists in the function but the app has no SoHum sign-in, so no team member has ever joined. How the app signs in to SoHum is undecided.
- **Not verified live:** that signed entitlements verify in a phone web view (WebCrypto ECDSA r||s); that `redeem_code`, `check_entitlement`, `get_public_keys`, `join_team` work against the deployed function; that the SoHum token check works through the JWKS (HQ confirmed the JWKS is published, not that a real token verifies); rate limits and replay rejection against the deployed function (tested only locally: 32 tests pass on real Postgres 15 and the fake store, per the step report in `docs/geoziptag-service/REPORT.md`).
- **Known gap:** role and actor headers are not under the console HMAC (contract 0.1.1), so anyone holding the secret can claim any role. The secret lives only on the console API. A later contract version should sign them (`docs/geoziptag-service/QUESTIONS.md` item 6).

## Step briefs

- Service brief: [docs/briefs/GEOZIPTAG_SERVICE_backend.md](docs/briefs/GEOZIPTAG_SERVICE_backend.md): **done** (GeoZipTag#7, merged and live). Report: [docs/geoziptag-service/REPORT.md](docs/geoziptag-service/REPORT.md); questions with answers: [docs/geoziptag-service/QUESTIONS.md](docs/geoziptag-service/QUESTIONS.md).
- App brief: [docs/briefs/GEOZIPTAG_APP_frontend.md](docs/briefs/GEOZIPTAG_APP_frontend.md): for the cloud GeoZipTag session or a step session, **not started**. Part 2 (team sign-in) waits on how the app signs in to SoHum.
- Both pinned to `sohum-contracts` `0a2a17c`.

## Next

1. App part 1 (redeem row, verify, daily check, grace, banner off, flag `ENTITLEMENTS_LIVE=false`): start from the app brief once HQ relays it to the cloud GeoZipTag session. First: put the public keys from `~/geoziptag-keys` into the app (key id `key-2026-11`); the owner provides the file, never the private key.
2. Then a real-phone test with an owner-created code; only after that flip the flag by wireless update (preview channel first).
3. Update `web/privacy.html` for what the redeem call sends before any app change ships.
4. Decide how the app signs in to SoHum (blocks team joining), then app part 2.
5. Later: store billing (step 3 of the build order).

## Blocked

- Team joining: the app has no SoHum sign-in; method undecided (blocks app part 2).
- App part 1 can start now: it needs nothing more from the service or the console.

## Waiting on the owner

- Decide how the app signs in to SoHum (for team plans only).
- Later: store subscription products, price points, store server credentials.
- Confirm the build order assumed: step 1 codes (done in the service), step 2 team plans and sign-in membership, step 3 store billing.
- Not yet decided: how signed-in joining reuses the register's team code.

## Open pull requests

- This ledger update: draft PR from `desk/geoziptag-status-live-2026-11-28` (not merged).
- Merged: [sohum-contracts#118](https://github.com/SoHum-Digital-Services/sohum-contracts/pull/118), [#119](https://github.com/SoHum-Digital-Services/sohum-contracts/pull/119) (per HQ), [GeoZipTag#7](https://github.com/SoHum-Digital-Services/GeoZipTag/pull/7) (service), sohum-console-api #9 and #11, sohum-console-web #14. The master document row is being updated by HQ (sohum-contracts#120).

## Live

Browser app at https://sohum-digital-services.github.io/GeoZipTag/ and the wireless update channel (from `main`). Android and iPhone builds: store release state not verified here (README says test ads "until the store listings exist").

**Actions service (new, 2026-11-28):** migration applied and function `geoziptag-actions` deployed to project `sohum`, secrets set, console wired and its screens live (details above, as reported by HQ). **Not live:** anything in the app: no entitlement, redeem or banner change reaches users. Master document row: HQ updating via sohum-contracts#120.
