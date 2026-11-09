-- Deleting an account must delete its profile.
--
-- `001_core_auth.sql` created `profiles.id` with a plain
-- `REFERENCES auth.users`, so deleting a user failed with
-- `23503 update or delete on table "users" violates foreign key constraint
-- "profiles_id_fkey"` — which also breaks Supabase's own "Delete user" button
-- and any account-removal flow. Re-create the constraint as ON DELETE CASCADE;
-- the trigger (`handle_new_user`) still creates the row on insert.

ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey
  FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE;
