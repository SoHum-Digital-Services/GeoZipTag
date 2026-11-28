# GeoZipTag status            updated 2026-11-28 by Desk · GeoZipTag (handover from the cloud session folded in)

Covers this repository (`SoHum-Digital-Services/GeoZipTag`, folder `GeoZipTag`; iOS and Android camera app, bundle `cc.sohum.geoziptag`). How this ledger works: `sohum-contracts` docs/OPERATING_MODEL.md. Facts below were read from the repository on 2026-11-28; nothing was run or deployed in this turn. "Not verified" means exactly that.

## Now

- Desk created 2026-11-28 (HQ brought the vertical in from a lone cloud session). This turn: this ledger and a **design proposal** for console-managed Pro, trials and coupon codes: [docs/CONSOLE_ENTITLEMENTS_PROPOSAL.md](docs/CONSOLE_ENTITLEMENTS_PROPOSAL.md), with a draft contract in [docs/contracts-draft/](docs/contracts-draft/). **Design only: no app code, no database change, nothing sent to the console repos.**

## What exists (from the code)

- Main is at a9c4d9b (PRs #2 to #6 merged). New in the web app: Attendance area (Employees / Shifts / Register / Team), per-employee shifts, week offs and rotation, ON TIME / LATE / EARLY / WEEK OFF marks, Week Off style, flash button always visible, Android front-camera display flash (native 1.25). Employees, shifts and passport photos live in localStorage.
- Web app in `web/` (one copy, bundled into both phone apps and published to GitHub Pages): GPS photo/video stamp, satellite map, photo attendance with employee IDs and shifts, Week Off mode, reports.
- Android 1.25 (code 26) and iPhone 1.25 (build 26): native shells around `web/`. Signed wireless updates of `web/` (ECDSA P-256, public key bundled in the app; `tools/ota/`).
- Optional shared team register on the **`sohum` Supabase project** (`ziebgspujtdzkiwyybsa`): the app calls `rpc/geoziptag_*` functions and bucket `geoziptag-photos` with the publishable key; a team is a code plus a 6-digit manager PIN. **No user accounts, no device identity, no sign-in anywhere in the app.** Per the cloud session's handover (not re-verified by this desk): tables `geoziptag_teams` and `geoziptag_attendance` and functions `geoziptag_create_team / join / submit / list / team_folder` are in the **public** schema; that session applied a migration on 2026-11-28 (action `weekoff` allowed; nullable `shift`, `status`, `photo_kind`; `submit` and `list` updated; Week Off rows have GPS/place stripped server-side; verified with a rolled-back test). The migration files are not in this repository (not verified where they live); they should be committed here or to the console repo.
- Ads: one Google AdMob banner in the photo view on Android and iPhone, **Google test ad IDs only** until store listings exist (`android/app/build.gradle`, `ios/project.yml`). Always shown; there is no Pro, trial, coupon or entitlement concept in the code today.
- Privacy policy in `web/privacy.html` (says what the register stores; says nothing about entitlements).

## Next

1. Owner decisions (below), put to HQ.
2. On decisions: Desk · Contracts merges the entitlement contract (draft is ready here); Desk · Console builds the admin screens and API; this desk then writes a brief for the app side (verify signed entitlement, hide the banner, redeem screen). Order: contract, console API + migration (applied only on the owner's word), app.
3. Where Pro hooks in (from the handover, checked: `web/camera.js` "Banner ad (apps only)" and the `adShow`/`adHide` bridge calls; `dialog#settings` in `web/index.html` for a "Redeem code" row). A page-level entitlement check before `adShow` needs no native build, so the first app step can ship by wireless update (and preview channel first).
4. Update `web/privacy.html` for whatever the redeem call sends before any app change ships.

## Blocked

- Everything past design waits on the owner decisions below and on a console entitlements API that does not exist yet.

## Waiting on the owner

- **(a) Billing:** are individual Pro subscriptions sold through Apple/Google in-app billing, codes only, or both? (Store rules require their billing for in-app digital subscriptions; a code-only model is safe for team/organisation plans sold outside the app and for promotional trials, but see the proposal, section 3.)
- **(b) Codes:** may one code be used by many people (campaign code with a usage cap) or only once per phone/person? Proposal supports both; the owner picks the default.
- **(c) Account model:** device-only (no sign-in; entitlement bound to an anonymous install id) or SoHum sign-in? This decides whether a subscription survives a new phone and whether personal data is collected.
- Smaller: price points; whether "Pro" removes only the banner or also unlocks features; trial length defaults; whether a team plan covers named members or anyone with the team code.

## Open pull requests

None open. (Branch `desk/geoziptag-status-and-entitlements-proposal`, this ledger plus the proposal, pushed and rebased on main; no PR yet.)

## Live

Browser app at https://sohum-digital-services.github.io/GeoZipTag/ and the wireless update channel (from `main`). Android and iPhone builds: store release state not verified here (README says test ads "until the store listings exist"). Entitlements, codes and console integration: **nothing exists or is live.** Not yet a row in the master document's status table (3.1); HQ to add (rule 11).
