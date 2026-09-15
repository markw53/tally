-- ===========================================================================
-- Tally on Supabase
--
-- Run this once, whole, in the SQL Editor of a new project. It is idempotent:
-- running it again after an upgrade is safe and won't touch your data.
--
-- The shape of the thing:
--
--   * Each person's diary, weights, settings and activity are rows keyed by
--     their auth user id, and row-level security means Postgres itself refuses
--     to hand one person the other's rows. That's a stronger guarantee than
--     the offproxy version, where the same promise was kept by my code being
--     correct.
--
--   * Custom foods are deliberately SHARED across everyone in the project.
--     Create "Mum's lasagne" once and the household can log it.
--
--   * Activity (active energy from a watch) is readable by its owner but
--     writable only by the service role — that is, only by the activity edge
--     function. A phone that knows nothing about the field cannot wipe what
--     your Shortcut posted.
--
-- Merging is per row, "newest timestamp wins", done in sync_diary/sync_foods
-- below. updated_at is client wall-clock milliseconds, which is what makes an
-- offline phone able to say "my Tuesday is newer than yours" after the fact.
-- ===========================================================================

-- Supabase keeps extensions in their own schema; the fallback is for a plain
-- Postgres (the test harness in supabase/test/) where that schema doesn't exist.
do $$
begin
  create extension if not exists pgcrypto with schema extensions;
exception when others then
  create extension if not exists pgcrypto;
end $$;

-- ----------------------------------------------------------------- tables ---

create table if not exists public.days (
  user_id    uuid   not null references auth.users(id) on delete cascade,
  date       date   not null,
  meals      jsonb  not null default '{}'::jsonb,
  updated_at bigint not null,
  primary key (user_id, date)
);

create table if not exists public.weights (
  user_id    uuid             not null references auth.users(id) on delete cascade,
  date       date             not null,
  kg         double precision not null,
  updated_at bigint           not null,
  primary key (user_id, date)
);

create table if not exists public.settings (
  user_id    uuid   primary key references auth.users(id) on delete cascade,
  value      jsonb  not null default '{}'::jsonb,
  updated_at bigint not null
);

-- Shared on purpose. id is the client-generated food id, so the same food
-- created offline on two devices converges instead of duplicating.
create table if not exists public.foods (
  id         text    primary key,
  food       jsonb,
  deleted    boolean not null default false,
  updated_at bigint  not null,
  updated_by uuid    references auth.users(id) on delete set null
);

-- Written only by the activity edge function, never by a syncing client.
create table if not exists public.activity (
  user_id    uuid    not null references auth.users(id) on delete cascade,
  date       date    not null,
  kcal       integer not null check (kcal >= 0 and kcal <= 20000),
  updated_at bigint  not null,
  primary key (user_id, date)
);

-- Long-lived keys for things that can't hold a session — the iOS Shortcut,
-- essentially. Only the hash is stored, so a copy of this table does not let
-- anyone post activity.
create table if not exists public.device_keys (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  key_hash     text        not null unique,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

-- Shared Open Food Facts cache, so two people scanning the same tin of beans
-- costs one upstream request. Service role only.
create table if not exists public.off_cache (
  k          text        primary key,
  payload    jsonb       not null,
  fetched_at timestamptz not null default now()
);

create index if not exists off_cache_fetched_idx on public.off_cache (fetched_at);

-- -------------------------------------------------------------------- RLS ---
-- Default-deny: every table has RLS on, and anything without a matching
-- policy below is refused. off_cache deliberately has no policies at all.

alter table public.days        enable row level security;
alter table public.weights     enable row level security;
alter table public.settings    enable row level security;
alter table public.foods       enable row level security;
alter table public.activity    enable row level security;
alter table public.device_keys enable row level security;
alter table public.off_cache   enable row level security;

do $$
begin
  -- your own diary, and nobody else's
  if not exists (select 1 from pg_policies where tablename = 'days' and policyname = 'own days') then
    create policy "own days" on public.days
      for all to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;

  if not exists (select 1 from pg_policies where tablename = 'weights' and policyname = 'own weights') then
    create policy "own weights" on public.weights
      for all to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;

  if not exists (select 1 from pg_policies where tablename = 'settings' and policyname = 'own settings') then
    create policy "own settings" on public.settings
      for all to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;

  -- the shared food library: everyone signed in, which is why sign-ups must
  -- be switched off once you've made your accounts (see supabase/README.md)
  if not exists (select 1 from pg_policies where tablename = 'foods' and policyname = 'household foods') then
    create policy "household foods" on public.foods
      for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'foods' and policyname = 'household foods write') then
    create policy "household foods write" on public.foods
      for insert to authenticated with check (updated_by = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'foods' and policyname = 'household foods edit') then
    create policy "household foods edit" on public.foods
      for update to authenticated
      using (true) with check (updated_by = (select auth.uid()));
  end if;

  -- activity: read your own, write nothing. The edge function uses the
  -- service role, which bypasses RLS, so this doesn't block the Shortcut.
  if not exists (select 1 from pg_policies where tablename = 'activity' and policyname = 'read own activity') then
    create policy "read own activity" on public.activity
      for select to authenticated using (user_id = (select auth.uid()));
  end if;

  -- you can see and revoke your own device keys; you can't see the other
  -- person's, and the hash is all that's there anyway
  if not exists (select 1 from pg_policies where tablename = 'device_keys' and policyname = 'own device keys') then
    create policy "own device keys" on public.device_keys
      for all to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end $$;

-- --------------------------------------------------------------- merging ---
-- One round trip per sync: send what this device believes, get back the
-- merged truth. Row-level "newer wins" rather than the whole-document merge
-- the Go server did, which means two devices editing *different* days can no
-- longer lose one of them.

create or replace function public.sync_diary(
  p_days     jsonb default '{}'::jsonb,
  p_weights  jsonb default '{}'::jsonb,
  p_settings jsonb default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Days. The date filter matters: a junk key would otherwise abort the whole
  -- sync on a cast error, losing good days along with the bad one.
  insert into days (user_id, date, meals, updated_at)
  select uid,
         key::date,
         coalesce(value -> 'meals', '{}'::jsonb),
         coalesce((value ->> 'updatedAt')::bigint, 0)
  from jsonb_each(coalesce(p_days, '{}'::jsonb))
  where key ~ '^\d{4}-\d{2}-\d{2}$'
    and jsonb_typeof(value -> 'meals') = 'object'
  on conflict (user_id, date) do update
    set meals = excluded.meals, updated_at = excluded.updated_at
    where excluded.updated_at > days.updated_at;

  insert into weights (user_id, date, kg, updated_at)
  select uid,
         key::date,
         (value ->> 'value')::double precision,
         coalesce((value ->> 'updatedAt')::bigint, 0)
  from jsonb_each(coalesce(p_weights, '{}'::jsonb))
  where key ~ '^\d{4}-\d{2}-\d{2}$'
    and jsonb_typeof(value -> 'value') = 'number'
  on conflict (user_id, date) do update
    set kg = excluded.kg, updated_at = excluded.updated_at
    where excluded.updated_at > weights.updated_at;

  if p_settings is not null and jsonb_typeof(p_settings -> 'value') = 'object' then
    insert into settings (user_id, value, updated_at)
    values (uid,
            p_settings -> 'value',
            coalesce((p_settings ->> 'updatedAt')::bigint, 0))
    on conflict (user_id) do update
      set value = excluded.value, updated_at = excluded.updated_at
      where excluded.updated_at > settings.updated_at;
  end if;

  return jsonb_build_object(
    'days', coalesce((
      select jsonb_object_agg(to_char(date, 'YYYY-MM-DD'),
                              jsonb_build_object('updatedAt', updated_at, 'meals', meals))
      from days where user_id = uid), '{}'::jsonb),
    'weights', coalesce((
      select jsonb_object_agg(to_char(date, 'YYYY-MM-DD'),
                              jsonb_build_object('updatedAt', updated_at, 'value', kg))
      from weights where user_id = uid), '{}'::jsonb),
    'activity', coalesce((
      select jsonb_object_agg(to_char(date, 'YYYY-MM-DD'),
                              jsonb_build_object('updatedAt', updated_at, 'value', kcal))
      from activity where user_id = uid), '{}'::jsonb),
    'settings', (
      select jsonb_build_object('updatedAt', updated_at, 'value', value)
      from settings where user_id = uid)
  );
end $$;

create or replace function public.sync_foods(p_foods jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- A deletion is a tombstone with a timestamp, not a missing row, so a device
  -- that's been offline since before the delete doesn't resurrect the food.
  insert into foods (id, food, deleted, updated_at, updated_by)
  select key,
         case when coalesce((value ->> 'deleted')::boolean, false)
              then null else value -> 'food' end,
         coalesce((value ->> 'deleted')::boolean, false),
         coalesce((value ->> 'updatedAt')::bigint, 0),
         uid
  from jsonb_each(coalesce(p_foods, '{}'::jsonb))
  where length(key) between 1 and 200
    and (jsonb_typeof(value -> 'food') = 'object'
         or coalesce((value ->> 'deleted')::boolean, false))
  on conflict (id) do update
    set food = excluded.food,
        deleted = excluded.deleted,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    where excluded.updated_at > foods.updated_at;

  return jsonb_build_object('foods', coalesce((
    select jsonb_object_agg(id, case when deleted
             then jsonb_build_object('updatedAt', updated_at, 'deleted', true)
             else jsonb_build_object('updatedAt', updated_at, 'food', food) end)
    from foods), '{}'::jsonb));
end $$;

-- --------------------------------------------------- device keys for iOS ---
-- Returns the key ONCE, in the clear. Only its hash is stored, so if you lose
-- it you issue another rather than recovering this one.

create or replace function public.issue_device_key(p_label text default 'iPhone')
returns text
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  uid uuid := (select auth.uid());
  raw text;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  raw := 'tk_' || encode(gen_random_bytes(24), 'hex');

  insert into device_keys (user_id, key_hash, label)
  values (uid, encode(digest(raw, 'sha256'), 'hex'), coalesce(nullif(trim(p_label), ''), 'device'));

  return raw;
end $$;

revoke all on function public.sync_diary(jsonb, jsonb, jsonb)  from public, anon;
revoke all on function public.sync_foods(jsonb)                from public, anon;
revoke all on function public.issue_device_key(text)           from public, anon;
grant execute on function public.sync_diary(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.sync_foods(jsonb)               to authenticated;
grant execute on function public.issue_device_key(text)          to authenticated;
