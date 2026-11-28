# geoziptag-actions

Supabase edge function (Deno) for GeoZipTag Pro: signed entitlements, redeem codes, team plans, and the console's admin actions.
Built against `sohum-contracts` at `0a2a17c` (`docs/GEOZIPTAG_ENTITLEMENT_SHAPE.md` 0.1.1). The pinned schemas and examples used by the
tests are copied to `tests/contract/`; `manifest.json` is the contract's manifest example, byte for byte (a test fails if they differ).

Paths: `/geoziptag-actions/<action>`; `GET .../manifest`, `GET .../health` (`{ ok, version }`). Admin calls need the console HMAC
(`X-Console-*` headers, signed text `timestamp.METHOD.path.body`). Writes are `POST .../<name>/propose` then `.../confirm`.

| File | What |
|---|---|
| `index.ts` | entry: reads env, builds the Postgres store |
| `handler.ts` | routing, admin gate (HMAC, skew, replay, role), propose/confirm, envelope |
| `hmac.ts`, `signing.ts`, `codes.ts` | HMAC check, ES256 signing and keyed hashes, code generation |
| `store.ts`, `pg_store.ts` | the database interface; its Postgres implementation (parameterised SQL only) |
| `actions/` | `reads.ts`, `writes.ts`, `app.ts` (redeem, check, keys, join), `common.ts` |
| `tests/` | contract and behaviour tests; `memory_store.ts` is the fake store |

Environment (names only, see `.env.example`): `GEOZIPTAG_SIGNING_KEY`, `GEOZIPTAG_SIGNING_KEY_ID`, `GEOZIPTAG_PUBLIC_KEYS`,
`GEOZIPTAG_CONSOLE_SECRET`, `GEOZIPTAG_CODE_PEPPER`; provided: `SUPABASE_URL`, `SUPABASE_DB_URL`.

## Checks (run from this folder)

```bash
deno fmt --check && deno lint
deno check index.ts
deno test --allow-read --allow-env tests/
```

Against a **throwaway local, empty** Postgres as well (applies the migration file to it, plus a stub `public.geoziptag_teams`; never use a live URL):

```bash
GEOZIPTAG_TEST_DB_URL=postgres://postgres@127.0.0.1:5432/scratch deno test --allow-read --allow-env --allow-net=127.0.0.1 tests/
```

Notes: the readable redeem code is derived from the proposal id and the pepper (HMAC), so it is never stored and a confirm retried
with the same key still shows it. Rollback SQL is in `supabase/rollbacks/` (not `migrations/`, so the CLI does not read it as a second version 0001).
