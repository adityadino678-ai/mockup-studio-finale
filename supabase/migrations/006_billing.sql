-- 006_billing.sql — plans and per-month listing usage.
--
-- The quota is server-authoritative: a browser counter would be editable.
-- `profiles.plan` is the user's CURRENT paid plan; `plan_expires_at` bounds it
-- (an expired paid plan reads as free — the server decides, not the column).
-- `listing_usage` holds one row per user per calendar month (UTC) with the
-- number of Printify products CREATED through the app.
--
-- RLS: no policy grants the anon role anything. The browser never reads these
-- tables; it goes through /api/billing/status, and every write is done with
-- the service-role key server-side. Service role bypasses RLS.

alter table public.profiles
  add column if not exists plan text not null default 'free'
    check (plan in ('free', 'starter', 'pro', 'business')),
  add column if not exists plan_expires_at timestamptz;

create table if not exists public.listing_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  ym text not null,          -- 'YYYY-MM' UTC calendar month
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, ym)
);

alter table public.listing_usage enable row level security;

-- Atomic increment for the server (service role calls this RPC).
create or replace function public.increment_listing_usage(p_user_id uuid, p_ym text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.listing_usage (user_id, ym, count)
  values (p_user_id, p_ym, 1)
  on conflict (user_id, ym)
  do update set count = public.listing_usage.count + 1, updated_at = now();
$$;

revoke execute on function public.increment_listing_usage(uuid, text) from anon, authenticated;
