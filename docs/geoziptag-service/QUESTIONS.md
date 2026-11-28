# Questions (none blocked the build; each has the default I used)

1. **`public.geoziptag_teams` columns.** The register's migrations are not in this repository. I assumed columns `id` (compared as text), `name`, `code` (the join code), read only, all in one place (`supabase/functions/geoziptag-actions/pg_store.ts`, `getTeamById`, `getTeamByCode`, `teamPlans`). Please confirm or give the real names.
2. **Removed members rejoining.** `join_team` refuses (409) a member an admin removed, so a removal sticks; the console has no "reinstate" action. OK, or should the team code let them back in?
3. **`grant_entitlement` end.** The contract does not say what neither `days` nor `ends_at` means. I require exactly one (422 otherwise), so a grant never has no end by accident. Team grants are refused there (use `change_team_plan`).
4. **Invalid SoHum token on `check_entitlement`.** Treated as no token (the install's own entitlement still applies); only `join_team` answers 401.
5. **Which project signs the SoHum token.** The verifier uses `SUPABASE_URL` of the function's own project (`sohum`): JWKS at `/auth/v1/.well-known/jwks.json`, audience `authenticated`. If the project still uses the legacy shared-secret JWT, there is no JWKS and every token fails closed.
6. **Role and actor headers are not under the HMAC** (contract 0.1.1 signs timestamp, method, path, body). Anyone holding the secret can claim any role. Fine while the secret is only on the console API; worth adding to the signed text in a later contract version.
