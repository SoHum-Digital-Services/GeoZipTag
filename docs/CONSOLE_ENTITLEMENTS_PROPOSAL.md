# GeoZipTag Pro, trials and codes, managed from the console: proposal

Status: **draft for the owner's decisions; nothing built.** Written 2026-11-28 by Desk · GeoZipTag. Input: the cloud session's design (session_018Lsc84nHFMEprLgdJBQR6X), treated as input, not decided.

## 1. What the owner wants

From console.sohum.cloud: manage individual Pro subscriptions; team memberships and plans; enable or disable Pro per account; create limited-time coupon / free-trial codes (1 week, 1 month, custom days) that people type into the app to remove the one AdMob banner.

## 2. The cloud draft, and what to change

Keep: an entitlements record per subject; redeem codes with days, expiry and a usage limit; the server signs the entitlement and the app verifies it offline with a public key (the app already does exactly this for wireless updates, `tools/ota/`, so the pattern is proven here); daily re-check; about 7 days offline grace.

Change or question:
- **Subject.** The app has no accounts. "Account" cannot be the key until decision (c). Until then the subject is an **install id**: a random UUID the app generates once and keeps on the phone (no hardware ids, no advertising id, no phone number). Cost: Pro is lost on reinstall or a new phone unless the owner wants sign-in.
- **Team.** The existing team is a code plus manager PIN stored in `sohum`. A team plan should hang off that team id: the console sets the team's plan; members' phones ask "is my joined team on a paid plan" with the team code. No new personal data.
- **One server, not two.** Entitlements must be checked and signed by the console API (Cloud Run), not by new RPCs in the app's Supabase path, so the console owns the data and audit (section 12.11: the console stores no vertical data; the vertical, here GeoZipTag, exposes the control-plane API). See section 5.
- **Signing key.** An Ed25519 or ECDSA P-256 key held by the server; only the public key goes in the app. Never in the repo. A key-id field allows rotation.
- **Fail-soft.** If the check fails or expires, the banner returns; the camera, stamping and register never lock.

## 3. Owner decisions and consequences

**(a) Billing.** Apple and Google require their in-app billing for digital subscriptions sold inside the app (and Apple restricts steering to outside payment). Options: (1) codes only: promotional trials, team and organisation plans sold outside the app, staff-issued; no in-app purchase UI; lowest build cost, safest for review. (2) store billing for individual Pro plus codes: needs StoreKit / Play Billing, receipt verification on the server, store product setup, and a place for the store's transaction id in the entitlement (`source: store`, store `product_id`, no card data ever touches SoHum). (3) both. **Recommendation:** ship codes + team plans first (option 1) because they meet the stated need and avoid store-billing review; add store billing later as a second `source`, which the draft contract already allows additively. Not legal advice; the owner should check current store terms before selling any subscription.

**(b) Code reuse.** Draft supports `max_redemptions` (1 = single use, N = campaign) and `per_install_limit` 1. Recommendation: single-use by default for individual codes, campaign codes capped (for example 500) with an expiry.

**(c) Account model.** Device-only keeps GeoZipTag's current no-account privacy stance and adds no personal data, but Pro does not move between phones; a restore flow could re-enter the same code (the install id changes, so a multi-use code could be reused; single-use codes would need support help). SoHum sign-in (`SOHUM_ID.md`) fixes portability but is a new personal-data decision for the owner and a larger build. Recommendation: device-only now, entitlement schema already has `subject.kind: account` for later.

## 4. Data model (proposed; a migration PR comes only after contract merge)

Table `entitlements`: id, subject_kind (`install` | `team` | `account`), subject_id, plan (`pro`), source (`paid` | `store` | `coupon` | `trial` | `team` | `admin`), starts_at, ends_at (null = no end), enabled (bool; false = disabled by an admin), redeemed_code_id, created_by (admin actor), note, created_at.
Table `redeem_codes`: id, code_hash (store a hash; show the code once at creation), label, days, valid_until, max_redemptions, redeemed_count, enabled, created_by, created_at.
Table `redemptions`: id, code_id, entitlement_id, install_id_hash, redeemed_at. (Hash only; no IP stored.)
RLS on, deny all by default, service role only through the API (section 12.7). Every admin action audited with actor, action, request id, outcome.

## 5. API (control-plane, behind the manifest v2 of contract 3.1; draft shapes in `docs/contracts-draft/`)

App-facing (public, no secret in the app): `POST /v1/entitlements/redeem` `{install_id, code}` returns a signed entitlement; `POST /v1/entitlements/check` `{install_id, team_code?}` returns a signed entitlement (or none). Rate-limited per install and per IP; generic error for bad/expired/used codes (no code enumeration).
Admin (scope admin, propose then confirm, idempotency key): create/list/disable codes; grant, extend, disable, enable an entitlement for an install, team or account; set a team's plan; list a subject's entitlements (install ids masked). Audit on all.
Signed payload (JSON, signature detached): `schema`, `subject`, `plan`, `source`, `starts_at`, `ends_at`, `enabled`, `issued_at`, `check_after` (daily), `grace_until` (issued_at + 7 days), `key_id`. The app trusts the payload only if the signature verifies and the clock is within `starts_at`..`ends_at`/`grace_until`. Local clock tampering is a known, accepted weakness for a banner removal.

## 6. Privacy

Collected: install id (random), code redeemed, timestamps. Not collected: name, email, phone, location, advertising id. Install id is separate from the team register. `web/privacy.html` must be updated before release. Banner removal changes AdMob data flow only by ending it; no extra SDK.

## 7. Who does what (through HQ)

Desk · Contracts: review/merge the draft contract. Desk · Console (`local_16b5dd1b-...`): API, migration, admin screens (needs this proposal; the cloud session already messaged it). Desk · GeoZipTag: app brief and later app steps. Owner: decisions (a)-(c), signing-key creation and any migration or deploy.

## 8. Not decided, not built

All of the above. No key exists, no table exists, no API exists, no live write was made.
