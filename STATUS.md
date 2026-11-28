# GeoZipTag status            updated 2026-11-28 by Desk · GeoZipTag (handover from the cloud session folded in)

Covers this repository (`SoHum-Digital-Services/GeoZipTag`, folder `GeoZipTag`; iOS and Android camera app, bundle `cc.sohum.geoziptag`). How this ledger works: `sohum-contracts` docs/OPERATING_MODEL.md. Facts below were read from the repository on 2026-11-28; nothing was run or deployed in this turn. "Not verified" means exactly that.

## Now

- **Roles (HQ, 2026-11-28):** the cloud GeoZipTag session does all app work (iOS/Android code, in-app UI, AdMob). This desk keeps this ledger, the contract work (entitlement and redeem-code shapes, as a draft for a sohum-contracts PR) and console integration with Desk · Console, and reports to HQ. This desk edits no app code and nothing on the cloud session's branches; it cannot be messaged from HQ, so anything it needs is written here or in `docs/` and HQ relays it.
- **Owner decisions (relayed by HQ 2026-11-28, "yes, those defaults are fine"):** Pro removes the AdMob banner only. Codes and free offers are built first; individual paid Pro through Apple/Google billing is later and not in the first build (`source: paid` stays in the shape). A code can be used by several people up to a per-code limit (1 = single use), every redemption recorded. Device-based by default; SoHum sign-in only for team plans and memberships (members inherit the team's plan; removing a member removes their entitlement). Kept: signed entitlement, public-key check, daily re-check, ~7-day grace, propose then confirm, owner/operator only. Recorded in contracts#118 (updated).

- Desk created 2026-11-28 (HQ brought the vertical in from a lone cloud session). This turn: this ledger and a **design proposal** for console-managed Pro, trials and coupon codes: [docs/CONSOLE_ENTITLEMENTS_PROPOSAL.md](docs/CONSOLE_ENTITLEMENTS_PROPOSAL.md), with a draft contract in [docs/contracts-draft/](docs/contracts-draft/). **Design only: no app code, no database change, nothing sent to the console repos.**

## What exists (from the code)

- Main is at a9c4d9b (PRs #2 to #6 merged). New in the web app: Attendance area (Employees / Shifts / Register / Team), per-employee shifts, week offs and rotation, ON TIME / LATE / EARLY / WEEK OFF marks, Week Off style, flash button always visible, Android front-camera display flash (native 1.25). Employees, shifts and passport photos live in localStorage.
- Web app in `web/` (one copy, bundled into both phone apps and published to GitHub Pages): GPS photo/video stamp, satellite map, photo attendance with employee IDs and shifts, Week Off mode, reports.
- Android 1.25 (code 26) and iPhone 1.25 (build 26): native shells around `web/`. Signed wireless updates of `web/` (ECDSA P-256, public key bundled in the app; `tools/ota/`).
- Optional shared team register on the **`sohum` Supabase project** (`ziebgspujtdzkiwyybsa`): the app calls `rpc/geoziptag_*` functions and bucket `geoziptag-photos` with the publishable key; a team is a code plus a 6-digit manager PIN. **No user accounts, no device identity, no sign-in anywhere in the app.** Per the cloud session's handover (not re-verified by this desk): tables `geoziptag_teams` and `geoziptag_attendance` and functions `geoziptag_create_team / join / submit / list / team_folder` are in the **public** schema; that session applied a migration on 2026-11-28 (action `weekoff` allowed; nullable `shift`, `status`, `photo_kind`; `submit` and `list` updated; Week Off rows have GPS/place stripped server-side; verified with a rolled-back test). The migration files are not in this repository (not verified where they live); they should be committed here or to the console repo.
- Ads: one Google AdMob banner in the photo view on Android and iPhone, **Google test ad IDs only** until store listings exist (`android/app/build.gradle`, `ios/project.yml`). Always shown; there is no Pro, trial, coupon or entitlement concept in the code today.
- Privacy policy in `web/privacy.html` (says what the register stores; says nothing about entitlements).

## Actions service: not built

`geoziptag-actions` (the console manifest, admin and app actions of contracts GEOZIPTAG_ENTITLEMENT_SHAPE) **does not exist**: no function, tables, keys or secrets. The only GeoZipTag backend today is the team register (`public` tables and `geoziptag_*` RPCs on project `sohum`, base `https://ziebgspujtdzkiwyybsa.supabase.co/rest/v1/rpc/`), not manifest-shaped. Recommended host: Supabase edge function `geoziptag-actions` in `sohum`, base URL `https://ziebgspujtdzkiwyybsa.supabase.co/functions/v1`. To build it, as separate step briefs later (each its own session; contract pinned at contracts#118 plus #119):

1. **Migration** (file in `supabase/migrations/` here; applied to the live project only on the owner's instruction): entitlement, redeem-code (hashed), redemption, team-membership tables in their own schema, RLS on, no public policy, tested rollback.
2. **Function code** (`supabase/functions/geoziptag-actions`): manifest and health, the admin actions behind the console HMAC check (signs `timestamp.METHOD.path.body`, contracts#119), propose/confirm with idempotency, `redeem_code`, `check_entitlement`, `get_public_keys` (and later `join_team`), ES256 signing, rate limits, audit.
3. **Secrets** (owner creates, as function secrets, never in the repo or chat): the ES256 private key (public half goes into the app build) and the console HMAC secret (shared with Desk · Console's registry entry).
4. **Deploy** of the function: only on the owner's word through HQ.

## Next

1. Owner decisions (below), put to HQ. Desk · Console to be briefed by HQ on contracts#118 section 7 (registry entry, admin screens, HMAC credential); host of the actions service still open.
2. On decisions: Desk · Contracts merges the entitlement contract (draft is ready here); Desk · Console builds the admin screens and API; this desk then writes a brief for the app side (verify signed entitlement, hide the banner, redeem screen). Order: contract, console API + migration (applied only on the owner's word), app.
3. Where Pro hooks in (from the handover, checked: `web/camera.js` "Banner ad (apps only)" and the `adShow`/`adHide` bridge calls; `dialog#settings` in `web/index.html` for a "Redeem code" row). A page-level entitlement check before `adShow` needs no native build, so the first app step can ship by wireless update (and preview channel first).
4. Update `web/privacy.html` for whatever the redeem call sends before any app change ships.

## Blocked

- Nothing built yet: waits on the owner (signing key, HMAC secret, migration and deploy decisions) and on a console entitlements API that does not exist yet.

## Waiting on the owner

- Create the entitlement signing key (private half a managed secret; public half goes in the app); a migration and any deploy, each only on the owner's word through HQ.
- Later (step 3): store subscription products, price points, store server credentials.
- Confirm the build order I assumed: step 1 codes, trials, admin grants; step 2 team plans and sign-in membership; step 3 store billing.
- Not yet decided by anyone: host of the actions service (example: Supabase edge function `geoziptag-actions`); how signed-in joining reuses the register's team code.

## Open pull requests

- [SoHum-Digital-Services/sohum-contracts#118](https://github.com/SoHum-Digital-Services/sohum-contracts/pull/118): GeoZipTag entitlement and console integration contract 0.1 (**merged 2026-11-28**; five schemas plus team member, validated; examples, manifest example, 3.1 row; decisions recorded). 
- [SoHum-Digital-Services/sohum-contracts#119](https://github.com/SoHum-Digital-Services/sohum-contracts/pull/119): 0.1.1, the console admin signature covers method and path (test vector included). Open, for the owner to merge.
- None in this repo. (Branch `desk/geoziptag-status-and-entitlements-proposal`, this ledger plus the proposal, pushed and rebased on main; no PR yet.)

## Live

Browser app at https://sohum-digital-services.github.io/GeoZipTag/ and the wireless update channel (from `main`). Android and iPhone builds: store release state not verified here (README says test ads "until the store listings exist"). Entitlements, codes and console integration: **nothing exists or is live.** Not yet a row in the master document's status table (3.1); HQ to add (rule 11).
