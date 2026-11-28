1. Contract access: this session cannot read SoHum-Digital-Services/sohum-contracts (add_repo says no access even after the owner
   reconnected GitHub). The code follows the pinned copies in supabase/functions/geoziptag-actions/tests/contract/. Please have someone
   with access compare docs/GEOZIPTAG_ENTITLEMENT_SHAPE.md 0.1.1 sections 2 to 5 and 8 with the Entitlement block in web/camera.js.
2. Flag: the owner said the service is live, and the brief says to merge only with ENTITLEMENTS_LIVE = false and flip it in a separate
   pull request. It stays false here. To try it on a phone first, a preview build with the flag true would be needed: say if wanted.
3. Part 2: how does the app sign in to SoHum (system browser, so native work and a new build)? Not started.
4. Passport/ID photos and the team register are unrelated to this step and unchanged.
