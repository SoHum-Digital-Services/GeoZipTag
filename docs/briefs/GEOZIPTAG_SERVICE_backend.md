# GeoZipTag actions service: edge function and migration (backend)

Repository `SoHum-Digital-Services/GeoZipTag`, branch `step/geoziptag-service` from `main`. Builder: a Claude model (Sonnet is enough for well-specified work) in a **fresh** Claude Code session. Status: not started. Written 2026-11-28 by Desk · GeoZipTag.

**Pinned contract:** `sohum-contracts` at commit `0a2a17c` (#118 entitlement shape 0.1, #119 signature 0.1.1). Build against that commit only; if the contract moves, keep building against the pin and say so in the report.

## Opening prompt (paste into a new Claude Code session in the GeoZipTag repository)

```
Read docs/briefs/GEOZIPTAG_SERVICE_backend.md in this repo and sohum-contracts at commit 0a2a17c (docs/GEOZIPTAG_ENTITLEMENT_SHAPE.md and the schemas it lists), and do that step only. Branch from main. Write no live change: no deploy, no migration applied, no secret anywhere. Stop and write docs/geoziptag-service/QUESTIONS.md if anything is ambiguous.
```

## Read only these

- `sohum-contracts`: `docs/SOHUM_SUITE_AND_CLOUD_CONSOLE.md` section 12 (binding; 12.11 console compatibility); `docs/SOHUM_VANI_CONTRACT.md` sections 3.1, 3.2, 4; `docs/GEOZIPTAG_ENTITLEMENT_SHAPE.md` (all, esp. 2 to 7); the five `schemas/sohum-geoziptag-*.schema.json` files and `schemas/examples/sohum-geoziptag-*.example.json`; `schemas/examples/geoziptag-manifest.example.json` (the manifest you serve).
- In this repo: `STATUS.md`, `docs/CONSOLE_ENTITLEMENTS_PROPOSAL.md`, `tools/ota/make-key.mjs` (pattern for a key-making script; **do not reuse the OTA key**), `web/camera.js` only to see how the app calls the existing `geoziptag_*` RPCs (do not change them).
- `sohum-console-api` `app/gateway.py` and `app/signing.py` (read only; that is exactly how the console calls you; do not edit that repo).

## What to build

### Where it lives

- `supabase/functions/geoziptag-actions/` (Deno, TypeScript): `index.ts` (router), `signing.ts`, `hmac.ts`, `store.ts` (the database interface and its Postgres implementation), `actions/*.ts`, `manifest.json` (a copy of the contract's manifest example; a test fails if they differ), `deno.json`, `config.toml` entry with `verify_jwt = false` (the console and the app send no Supabase JWT; the function does its own authentication: HMAC for admin calls, a verified SoHum token for `join_team`, rate limits for the public calls).
- `supabase/migrations/0001_geoziptag_entitlements.sql` and `0001_geoziptag_entitlements.down.sql`.
- Tests in `supabase/functions/geoziptag-actions/tests/`.
- `docs/geoziptag-service/REPORT.md` at the end.

Database access is by the function's `SUPABASE_DB_URL` (provided to edge functions) with a Postgres client and **parameterised SQL only**, so the new schema is never exposed through the REST API. Do not touch the existing `public.geoziptag_*` tables or functions; read `public.geoziptag_teams` only to get a team's name, and first check its real columns in the repo's history or ask in `QUESTIONS.md` (the migration files for it are not in this repo).

### Migration (own schema `geoziptag`; file only, never applied by you)

| Table | Columns (summary) | Notes |
|---|---|---|
| `entitlements` | id uuid pk, subject_kind, subject_id, plan, source, starts_at, ends_at null, enabled, redeemed_code_id null, team_id null, store jsonb null, note, created_at, created_by | one row per grant; a team plan is a row with subject_kind `team` |
| `redeem_codes` | id, label, kind, days, valid_until null, max_redemptions >= 1, redeemed_count, enabled, code_hash unique, code_hint, created_at, created_by | **hash only**: HMAC-SHA256 of the normalised code keyed with `GEOZIPTAG_CODE_PEPPER` |
| `redemptions` | id, code_id, entitlement_id, install_id_hash, redeemed_at; unique (code_id, install_id_hash) | the hash is a keyed hash of the install id; no IP, no device detail |
| `team_members` | id, team_id, account_id uuid, status active/removed, joined_at, removed_at, removed_by; unique (team_id, account_id) | account id is the SoHum (Supabase) `sub`; no name or email |
| `proposals` | id text pk, action, actor, params jsonb, created_at, expires_at, confirmed_key null, result jsonb null | propose-then-confirm state (the service stores its own; it does not trust the console's) |
| `idempotency` | key text, action, result jsonb, created_at; pk (key, action) | |
| `request_log` | request_id text pk, seen_at | rejects a repeated `X-Request-Id` inside the 5-minute window (replay) |
| `rate_counters` | bucket text, window_start, count; pk (bucket, window_start) | for redeem and check limits |
| `audit` | id, request_id, actor, role, action, phase, outcome, at, detail | every confirmed write and every admin call; **never** a readable code or a full install id |

RLS **enabled on every table with no policy at all** (deny all; only the function's database role gets in), `revoke all` from `anon` and `authenticated`, indexes on `(subject_kind, subject_id)`, `code_hash`, `(team_id, status)`. The `.down.sql` drops the schema. Test up, down, up on an empty local database. **Never apply it to the live project.**

### The 17 actions (exactly the contract manifest; paths `/geoziptag-actions/<name>`)

Admin (every one needs the valid HMAC and role `owner` or `operator`): `list_entitlements`, `get_entitlement`, `list_redeem_codes`, `list_redemptions`, `list_team_plans`, `list_team_members`, and the writes `grant_entitlement`, `revoke_entitlement`, `set_entitlement_enabled`, `create_redeem_code`, `set_redeem_code_enabled`, `change_team_plan`, `remove_team_member`. App (public): `redeem_code`, `check_entitlement`, `get_public_keys`, `join_team` (the last needs a verified SoHum token). Plus `GET /geoziptag-actions/manifest` (no auth) and `GET /geoziptag-actions/health` returning `{ ok, version }`.

Behaviour to implement, each as the contract says:

- **Envelope:** success `{ success: true, data, meta }`, error `{ error: { code, message_en, message_te } }` (put the English in both fields; Telugu is not needed here). Lists return `{ items, next_cursor }` with `?cursor=&limit=` (default 50, max 200, as the manifest says). Status codes the console passes through: 400, 404, 409, 422. **Anything else the console shows as 502**, including a rejected signature, so use 401 for a bad signature and expect the console to say "service answered 401".
- **Reads** are `GET` with params in the query string (the console sorts them; the signed path includes the query string).
- **Writes (admin) are propose then confirm** (contract section 4): `POST .../<name>/propose` with the params as the JSON body validates them and returns `{ proposal_id, expires_at, summary, ... }` and changes nothing (the console requires `proposal_id` and uses `expires_at`; use 15 minutes). `POST .../<name>/confirm` with `{ proposal_id, idempotency_key }` runs in **one transaction**, records the result against the key, and a repeat with the same key returns the first result and acts once. An expired or unknown proposal is 409 (the console maps it) and a different key on an already-confirmed proposal is 409. Validate every request body against the manifest's `params_schema` and reject unknown fields with 422.
- **`create_redeem_code`:** generate the code in the service (8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, shown as `XXXX-XXXX`, from a cryptographic random source), store only the keyed hash and the last four as `code_hint`, and return the readable code **once**, in the confirm result (`sohum.geoziptag.redeem_code.created/1`). It is never in a list, a log or the audit table.
- **`redeem_code`** (public, not propose/confirm): normalise the typed code (ignore case, spaces, hyphens); one **generic** error (422 `INVALID_CODE`) for unknown, expired, disabled, used-up; codes are **multi-use up to `max_redemptions`** and one install redeems a given code once (a repeat by the same install returns the same entitlement, idempotent); the check, the count increment, the entitlement insert and the redemption row happen in **one transaction** with a row lock so two phones cannot both take the last use; **every redemption is recorded**. Entitlement: `source` = the code's kind, `starts_at` now, `ends_at` now + `days`. Different codes on one install create separate entitlements (no stacking); the signed reply is the active one that ends latest. Rate limit per install and per source address (429, a generic body). The source address is used only for the counter and is not stored in `redemptions`.
- **`check_entitlement`** (public): body `{ install_id, store_receipt? }`; `store_receipt` is ignored in this step (store billing is later). Returns `data` = the signed envelope for the install's active, enabled entitlement that ends latest; if there is none but the install has a disabled or ended one, sign the most recent so the app sees `enabled:false` or the past `ends_at`; if it never had one, `data: null`. If the request carries `Authorization: Bearer <SoHum token>` **and** the account is an `active` member of a team whose plan is active and enabled, also derive a team entitlement (`subject` kind `account`, source `team`, `team_id`) and return whichever ends later. A removed member, or a disabled or ended plan, yields no team entitlement, so removal takes effect at the next check. `join_team` and the token check use the SoHum (Supabase Auth) token verified against the `sohum` project's JWKS; with no token, only the install's own entitlement applies.
- **Signing:** build the payload (`sohum.geoziptag.entitlement.payload/1`: `issued_at` now, `check_after` now + 24 h, `grace_until` = `issued_at` + 7 days but never past `ends_at`), serialise to UTF-8 JSON, `payload_b64` = base64url (no padding), `signature_b64` = base64url of the raw `r||s` ES256 signature (WebCrypto ECDSA P-256 SHA-256 returns raw `r||s`) over exactly those bytes, `key_id` from the secret. `get_public_keys` returns `sohum.geoziptag.public_keys/1` from the `GEOZIPTAG_PUBLIC_KEYS` setting (public data, not a secret).
- **HMAC check on every admin call (contract section 6, 0.1.1):** headers `X-Console-Timestamp`, `X-Console-Signature`, `X-Console-Actor`, `X-Console-Role`, `X-Request-Id`. Recompute lower-case hex HMAC-SHA256 with `GEOZIPTAG_CONSOLE_SECRET` over `timestamp + "." + METHOD + "." + path + "." + body`, where `path` is the request path after the base URL exactly as the console sent it (starting `/geoziptag-actions/`, with any query string) and `body` the raw bytes. Compare in constant time. Reject (401) a missing or wrong signature, a timestamp more than 300 seconds old **or ahead**, a repeated `X-Request-Id` seen in the window (replay), and (403) a role other than `owner` or `operator`. Reconstruct `path` from the incoming URL robustly (the edge runtime may show `/functions/v1/geoziptag-actions/...` or `/geoziptag-actions/...`; strip only a leading `/functions/v1`, then verify), and test both forms. The contract test vector (secret `example-secret-not-real`, timestamp `1796000000`, signature in section 6 of the contract doc) must pass in your tests.
- **Audit** every confirmed write and every admin call (actor, role, action, request id, outcome); no secrets, codes or full install ids.
- **Privacy:** collect nothing beyond the contract's list: install id (stored only as a keyed hash in redemptions; the full id appears in `entitlements.subject_id` because the signed payload must name it, masked in every admin read), code, timestamps, team member account id. No IP stored, no advertising id, no government identifiers. Admin reads mask install and account ids (`xxxx…xxxx`) and omit `member_count` below 10.

## Rules (binding)

1. Types and request validation come from the pinned schemas; do not invent a field, an endpoint or an enum value. Anything the contract lacks goes in `QUESTIONS.md`.
2. Parameterised SQL only; one transaction per confirm and per redeem; no string-built queries.
3. **No secrets in the repository, the report or the chat.** The secrets and settings are read from the environment by name only (list below). A `.env.example` with names and no values is allowed.
4. No deploy, no `supabase db push`, no live database access of any kind. Tests use a fake `store` (an in-memory implementation of the same interface) and, for SQL, an empty local Postgres only if one is available.
5. Do not change `web/`, `android/`, `ios/`, or the existing `public.geoziptag_*` objects; do not edit other repositories.
6. Stop on ambiguity: write `docs/geoziptag-service/QUESTIONS.md`, push it, and stop.

## Acceptance tests (supplied; make them pass, do not weaken them)

| # | Test | Expected |
|---|---|---|
| S1 | `manifest.json` equals the contract's `geoziptag-manifest.example.json`; every response validates against the pinned schemas | pass |
| S2 | Console test vector (made-up secret, timestamp `1796000000`) verifies; changing the method, the path, the query string or one body byte fails | pass |
| S3 | Admin call with no signature, a wrong one, an old or future timestamp, a repeated request id, a `viewer` or `admin` role | 401, 401, 401, 401, 401, 403; nothing changes |
| S4 | Propose changes nothing (row counts unchanged); confirm twice with the same key | one effect, same response both times |
| S5 | Confirm an expired or unknown proposal; a different key on a confirmed proposal | 409 each |
| S6 | `create_redeem_code` confirm returns the readable code once; the database holds only the hash and hint; list and audit never show it | pass |
| S7 | A code with `max_redemptions` 3 used by 4 installs, two at the same moment for the last use | exactly 3 succeed, each recorded once, the rest get the generic error |
| S8 | Same install redeems the same code twice | same entitlement, count incremented once |
| S9 | Unknown, expired, disabled and used-up codes | the same generic 422 body each |
| S10 | Signed envelope: verify `signature_b64` over the decoded `payload_b64` with the public key (test key generated in the test, never committed); `grace_until` <= `ends_at`; tamper one byte and it fails | pass |
| S11 | `check_entitlement`: active, disabled (signed `enabled:false`), ended, none (`data: null`); team member with a plan; removed member; disabled plan | as specified |
| S12 | Admin lists mask ids and omit member counts under 10; cursor paging returns every row once | pass |
| S13 | Migration up, down, up on an empty database (if a local Postgres is available; otherwise say not run) | clean |

## Done when (commands; put the real ones in the README of the function)

```
deno fmt --check && deno lint
deno check supabase/functions/geoziptag-actions/index.ts
deno test --allow-read supabase/functions/geoziptag-actions/tests/
# schema validation of every example and response used in the tests
```

All pass on a clean checkout. One pull request. No deploy, no live migration, no merge.

## What the owner does afterwards (nothing here is done by the builder)

In this order, each only on the owner's word through HQ:

1. **Create three secrets** and keep a backup of the private ones outside the repo: the ES256 signing key (make it with a script like `tools/ota/make-key.mjs` run locally; a **new** key, not the OTA one; private half PKCS8 base64 as `GEOZIPTAG_SIGNING_KEY`, its id as `GEOZIPTAG_SIGNING_KEY_ID`, the public half as `GEOZIPTAG_PUBLIC_KEYS` JSON and later in the app), the console HMAC secret (`GEOZIPTAG_CONSOLE_SECRET`, long random), and a code-hash pepper (`GEOZIPTAG_CODE_PEPPER`, long random). Set them as function secrets in project `sohum` (`supabase secrets set`, names only in any record).
2. **Review and apply the migration** to project `sohum` (a branch database first, then live).
3. **Deploy** the function `geoziptag-actions` with `verify_jwt` off (the function does its own authentication).
4. **Console side:** set `CONSOLE_SECRET_GEOZIPTAG` on `sohum-console-api` (Cloud Run) to the **same value** as `GEOZIPTAG_CONSOLE_SECRET`; list the operators in `CONSOLE_ROLES`.

## Checklist to flip the console from mock to the real service

The registry row already points at `https://ziebgspujtdzkiwyybsa.supabase.co/functions/v1/geoziptag-actions/manifest` (sohum-console-api #9). After steps 1 to 4 above:

- [ ] `GET .../geoziptag-actions/health` returns `{ ok, version }` and `GET .../manifest` validates (read only, no signature).
- [ ] The console's service page for GeoZipTag shows "up" and the manifest version, and the screens no longer say "Sample data".
- [ ] One read through the console (`list_redeem_codes`, empty) succeeds; an unsigned `curl` to an admin path returns 401 (read only checks).
- [ ] **With the owner present (live writes):** create one test code (limit 1), redeem it from a test phone, see the redemption in the log, disable the code. Confirm the audit rows exist.
- [ ] Rollback if anything misbehaves: remove `CONSOLE_SECRET_GEOZIPTAG` from the console API (the console then says admin calls are not configured), delete or disable the function, run the migration's down file.

## Not verified (say so in the report; do not claim otherwise)

That the Supabase edge runtime passes the path in the form you tested; that `SUPABASE_DB_URL` and a Postgres client work from the deployed function; that the real `public.geoziptag_teams` columns match what you read; anything against the live project or the live console; Telugu (none is needed).

## Report (commit as `docs/geoziptag-service/REPORT.md`)

```
Step:            GeoZipTag service, backend
Contract pin:    0a2a17c
Built:           function, migration, manifest copy, tests (one line each)
Tests:           commands run and result; tests not run and why
Not done:        ...
Deviations:      ...
Questions:       none | see QUESTIONS.md
Env variables:   names only (GEOZIPTAG_SIGNING_KEY, GEOZIPTAG_SIGNING_KEY_ID, GEOZIPTAG_PUBLIC_KEYS, GEOZIPTAG_CONSOLE_SECRET, GEOZIPTAG_CODE_PEPPER; provided: SUPABASE_URL, SUPABASE_DB_URL)
```

## Order of work

1. Migration and its down file, tested locally. 2. `signing.ts` and `hmac.ts` with their vector tests (S2, S10). 3. `store` interface and the fake. 4. Router, envelope, manifest, health, `get_public_keys`. 5. Admin reads, then writes with propose/confirm. 6. `redeem_code` and `check_entitlement`. 7. Team actions (`join_team`, `list_team_members`, `remove_team_member`, `change_team_plan`) last; if the SoHum token verification is unclear, build the rest and list it under Not done with a question.
