-- Rollback of 0001_geoziptag_entitlements.sql. Drops the whole geoziptag schema and everything in it
-- (entitlements, redeem codes, redemptions, memberships, audit). Does not touch public.geoziptag_*.
-- Kept outside supabase/migrations/ on purpose: the Supabase CLI would read a second file with version 0001 there as a migration.
drop schema if exists geoziptag cascade;
