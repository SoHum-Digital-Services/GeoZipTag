Step:            GeoZipTag app part 1, frontend (codes, trials and admin grants; device-based)
Contract pin:    0a2a17c (entitlement shape 0.1.1). Built against the pinned copies in
                 supabase/functions/geoziptag-actions/tests/contract/ (schemas and examples). Afterwards the session was given
                 read access to sohum-contracts, cloned at 0a2a17c (the pinned commit, HEAD), and docs/GEOZIPTAG_ENTITLEMENT_SHAPE.md
                 sections 2 to 5 and 8 were read and compared with the code: key lookup by key_id (unknown id untrusted), signature
                 verified then payload parsed, Pro only if enabled and inside starts_at..ends_at, re-check after check_after, offline
                 grace until grace_until (never past ends_at), banner back on any failure, nothing else locks, install id never joined
                 to team data. No difference found.
Built:
  web/camera.js    Entitlement block between "// ---- Entitlement (start)" / "(end)": random install id (geoziptagInstallId);
                   ES256 verification with WebCrypto against the bundled key (key-2026-11, SPKI, raw r||s signature);
                   checks of schema, plan "pro", subject.kind "install" and subject.id == this install, key_id match, dates;
                   entitled(now) (enabled, starts_at <= now < ends_at, now < grace_until); storage (geoziptagEntitlement)
                   re-verified on every load; redeem_code call with generic outcomes (ok / invalid / limited / offline);
                   check_entitlement re-check when check_after has passed (or the install ever redeemed), failed calls change
                   nothing; flag ENTITLEMENTS_LIVE.
                   Banner block between "// ---- Banner ad (start)" / "(end)": syncAd hides the slot, calls adHide() if shown and
                   never calls adShow while entitled; fails soft. Wiring: refresh on launch, on returning to the foreground and
                   every 60 s (the call is only made when due), so the banner returns by itself when Pro ends.
  web/index.html   Settings "Pro" group with a "Redeem code" row (hidden unless the flag is on), the Redeem code sheet, and a
                   "Pro codes" section in the in-app privacy sheet.
  web/style.css    .field style for the sheet.
  web/privacy.html "Pro codes" section (wording is the owner's to approve).
  tools/entitlement/test/  harness.mjs and entitlement.test.mjs (E1 to E8, plus E6b fail-soft, a no-secrets check and an install-id check).
Tests:
  node --test tools/entitlement/test/*.test.mjs   11 passed, 0 failed
                   (the brief's form "node --test tools/entitlement/test/" fails on Node 22 with "Cannot find module": use the glob)
  bash tools/ota/test/run.sh                      48 passed, 0 failed
  Browser checks (Playwright, Chromium, 390 px, scratchpad scripts not in the repo): Settings, ux, channel and the sheets-fit-width
                   checks re-run on the changed Settings dialog, 0 failures. With the flag off: no Redeem row, no call to the
                   service. With the flag on (test key, mocked service): the row shows; 422, 429 and an offline failure show the
                   generic messages and never the server text; a good code stores a verified entitlement and shows "Ads are off
                   until <date>"; it survives a restart; an edited stored entitlement is no longer trusted.
  Against the live service (read-only): get_public_keys returns key-2026-11 with the same public_key_b64 that is bundled;
                   check_entitlement for a fresh random install id returns {"success":true,"data":null}; the CORS preflight is
                   answered (204, access-control-allow-origin *).
Not done:        Part 2 (SoHum sign-in, join_team, bearer token on check_entitlement): the brief says not to start it until the
                 sign-in route is decided. Part 3 (store billing). get_public_keys is not called at run time on purpose: a key id
                 the app does not hold is untrusted and a new key arrives in an app update.
Not verified:    A real code redeemed against the live service (no real code was available); that crypto.subtle ECDSA works in the
                 Android WebView and the iPhone web view the way the app loads its pages (the app pages are served from
                 http://127.0.0.1 on iPhone and the app's own https origin on Android, both secure contexts, but not checked on
                 a device: if it is missing the feature fails soft and the banner stays); preview-channel behaviour on a phone;
                 the final privacy wording; store review impact.
Deviations:      (0) at the owner's request the app also checks every time it is opened or comes back to the front (at most once a
                 minute, and only on an install that holds an entitlement or has ever redeemed a code), not only after check_after, so
                 a revoke takes effect at the next open; a failed check still changes nothing. (1) the ad code got its own marker pair so E6 can load syncAd; (2) the check runs every 60 s only to re-evaluate
                 and call the service when due; (3) the Redeem row lives in its own "Pro" settings group; (4) "key-2026-11" has no
                 not_before in the bundled constant (the app does not use it).
Questions:       see QUESTIONS.md
Flag:            ENTITLEMENTS_LIVE = false (confirmed; test E7 asserts it)
