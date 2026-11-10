-- Migration 005: auth only.
--
-- The `/api/sync/*` routes were the ONLY writers of these tables, and they
-- are now deleted: they never had a client, all user data lives in the
-- visitor's own IndexedDB, and the server keeps only authentication and the
-- profile row (001) plus 004's ON DELETE CASCADE fix on profiles.
--
-- NOT APPLIED AUTOMATICALLY. Review this file first, then run it by hand
-- against the Supabase project (SQL editor or `supabase db push`) once the
-- app is confirmed to be auth-only in production. If run, any rows these
-- tables still hold are destroyed - that is the point, but do it knowingly.
--
-- Dependency order (CASCADE covers the cross-references between them):
--   printify_products (003) -> listing_drafts (003) -> designs (002)
--   mockups (002)
--   user_settings (003)

DROP TABLE IF EXISTS printify_products CASCADE;
DROP TABLE IF EXISTS listing_drafts CASCADE;
DROP TABLE IF EXISTS mockups CASCADE;
DROP TABLE IF EXISTS designs CASCADE;
DROP TABLE IF EXISTS user_settings CASCADE;
