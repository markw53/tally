-- Just enough of Supabase to run schema.sql unchanged against a plain
-- Postgres: the auth schema, auth.uid() reading the same GUC PostgREST sets,
-- and the three roles. Nothing here is deployed — it exists so the schema and
-- the merge functions are tested rather than merely written.

create schema if not exists auth;
create schema if not exists extensions;

create table if not exists auth.users (
  id    uuid primary key,
  email text unique
);

-- PostgREST puts the JWT subject here; Supabase's auth.uid() reads it back.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public, auth, extensions to anon, authenticated, service_role;
