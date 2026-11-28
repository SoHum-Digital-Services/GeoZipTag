# Report: GeoZipTag service, backend

```
Step:            GeoZipTag service, backend
Contract pin:    0a2a17c (sohum-contracts main tip; #118 shape 0.1, #119 signature 0.1.1)
Built:           function supabase/functions/geoziptag-actions (17 actions, manifest, health), migration + rollback,
                 manifest copy, key-making script for the owner, tests
Tests:           see below
Not done:        store billing (store_receipt ignored, as briefed); Telugu text (English in both fields, as briefed)
Deviations:      see below
Questions:       see QUESTIONS.md (none blocking)
Env variables:   GEOZIPTAG_SIGNING_KEY, GEOZIPTAG_SIGNING_KEY_ID, GEOZIPTAG_PUBLIC_KEYS, GEOZIPTAG_CONSOLE_SECRET,
                 GEOZIPTAG_CODE_PEPPER (names only; provided: SUPABASE_URL, SUPABASE_DB_URL)
```

## Tests run (all on 2026-11-28, from `supabase/functions/geoziptag-actions`)

- `deno fmt --check`, `deno lint`, `deno check index.ts tests/*.ts`: pass.
- `deno test --allow-read --allow-env tests/`: 18 passed, 1 ignored (the Postgres-only migration test), against the in-memory fake store.
- The same with `GEOZIPTAG_TEST_DB_URL` pointing at a throwaway local Postgres 15 (empty database, deleted afterwards): **32 passed, 0 failed**. That runs every behaviour test against `pg_store.ts` with real row locks (S7 concurrency) and S13: migration up, down, up, RLS on 9 tables, 0 policies.
- Tests use keys and secrets generated fresh in each run; nothing secret is in the repo. The key script was run once into a scratch folder, round-tripped, and deleted.
- Acceptance S1 to S13 are covered (S1, S2, S10 in `unit_test.ts`; S3 to S9, S11, S12 in `behaviour_test.ts`; S13 in `migration_test.ts`). Every signed envelope, record and example in the tests is validated against the pinned schemas.

## Deviations

1. Rollback SQL is `supabase/rollbacks/0001_geoziptag_entitlements.down.sql`, not in `migrations/` (the Supabase CLI would read a second file with version 0001 there). The up file keeps the brief's name `0001_...`; the CLI may want a timestamp name, since live history has later versions (`db push --include-all`, or rename).
2. The Postgres store is its own file `pg_store.ts`; `store.ts` holds the interface.
3. The readable code is **derived** (HMAC of the pepper and the random proposal id), not stored, so a confirm retried with the same key still returns it and the database never holds it. The proposal id comes from the CSPRNG, so the code is unpredictable without the pepper.
4. `supabase/config.toml` is new (the repo had none); it only carries the function's `verify_jwt = false`.
5. Audit is written for every call that passes the signature (reads, proposes, confirms, role denials, rejected writes). Bad-signature calls are not written (an unauthenticated caller must not grow the table). Public calls are not audited; redemptions are their own log.
6. Added `tools/geoziptag/make-signing-key.mjs` (the owner runs it; writes outside the repo; not the OTA key).

## Not verified

- That the Supabase edge runtime gives the path in the form tested (both `/functions/v1/geoziptag-actions/...` and `/geoziptag-actions/...` are handled and tested).
- That `SUPABASE_DB_URL` and the `postgres` client work from the deployed function (tested only against a local TCP Postgres; `prepare: false` is set for the pooler).
- That the real `public.geoziptag_teams` has the columns `id`, `name`, `code` (QUESTIONS.md 1); the local test used a stub table.
- That the sohum project's tokens verify through its JWKS (QUESTIONS.md 5); the tests use a stub verifier.
- Anything against the live project, the live console, or the app. No deploy, no migration applied, no secret created.

## What the owner does afterwards (each only on the owner's word)

1. **Create secrets** (back up the private ones outside the repo): run `node tools/geoziptag/make-signing-key.mjs <folder outside the repo> <key id>`; set function secrets in project `sohum`: `GEOZIPTAG_SIGNING_KEY` (from `GEOZIPTAG_SIGNING_KEY.txt`), `GEOZIPTAG_SIGNING_KEY_ID`, `GEOZIPTAG_PUBLIC_KEYS` (the JSON file), `GEOZIPTAG_CONSOLE_SECRET` (long random), `GEOZIPTAG_CODE_PEPPER` (long random, never change it once codes exist: it keys the code hashes).
2. **Apply the migration** `supabase/migrations/0001_geoziptag_entitlements.sql` to a branch database first, then live. Rollback: `supabase/rollbacks/...down.sql`.
3. **Deploy** `geoziptag-actions` (config.toml has `verify_jwt = false`).
4. **Console side:** set `CONSOLE_SECRET_GEOZIPTAG` on `sohum-console-api` (Cloud Run) to the same value as `GEOZIPTAG_CONSOLE_SECRET`; list operators in `CONSOLE_ROLES`.

## Checklist to flip the console from mock to the real service

The registry row already points at `https://ziebgspujtdzkiwyybsa.supabase.co/functions/v1/geoziptag-actions/manifest`.

- [ ] `GET .../geoziptag-actions/health` returns `{ ok, version }`; `GET .../manifest` validates.
- [ ] The console's GeoZipTag service page shows "up" and the manifest version; screens no longer say "Sample data".
- [ ] One read through the console (`list_redeem_codes`, empty) succeeds; an unsigned `curl` to an admin path gives 401.
- [ ] With the owner present: create a test code (limit 1), redeem it from a test phone, see the redemption in the log, disable the code; confirm the audit rows exist.
- [ ] Rollback: remove `CONSOLE_SECRET_GEOZIPTAG` from the console API, delete or disable the function, run the down file.
