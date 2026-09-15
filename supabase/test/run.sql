-- ===========================================================================
-- Tests for the Tally Supabase schema.
--
--   supabase/test/run.sh
--
-- Every test is an assert; the first failure aborts with a non-zero exit.
-- What's being checked is mostly the two promises the whole design rests on:
-- that newer-wins merging actually merges, and that row-level security means
-- one person genuinely cannot reach the other's diary.
-- ===========================================================================

\set ON_ERROR_STOP on
\set QUIET on
\timing off

-- Two people, as in the household this was built for.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'mark@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'claire@example.com')
on conflict do nothing;

-- PostgREST grants these; RLS is what narrows them back down.
grant select, insert, update, delete on all tables in schema public to authenticated;

create or replace function test_as(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid, true);
end $$;

\echo '— merging —'

begin;
  set local role authenticated;
  do $$ begin perform test_as('11111111-1111-1111-1111-111111111111'); end $$;

  do $$ begin perform sync_diary(
    '{"2026-09-14": {"updatedAt": 1000, "meals": {"Breakfast": [{"k": 300}]}}}'::jsonb); end $$;

  do $$ begin
    assert (select count(*) from days) = 1, 'a day should have been stored';
    assert (select meals -> 'Breakfast' -> 0 ->> 'k' from days) = '300', 'meals round-trip';
  end $$;

  -- an older device pushing a stale version of the same day must not win
  do $$ begin perform sync_diary(
    '{"2026-09-14": {"updatedAt": 500, "meals": {"Breakfast": [{"k": 999}]}}}'::jsonb); end $$;

  do $$ begin
    assert (select updated_at from days) = 1000, 'a stale day must not overwrite a newer one';
    assert (select meals -> 'Breakfast' -> 0 ->> 'k' from days) = '300', 'stale meals must not land';
  end $$;

  -- a newer one must
  do $$ begin perform sync_diary(
    '{"2026-09-14": {"updatedAt": 2000, "meals": {"Breakfast": [{"k": 450}]}}}'::jsonb); end $$;

  do $$ begin
    assert (select meals -> 'Breakfast' -> 0 ->> 'k' from days) = '450', 'a newer day must win';
  end $$;

  -- different days from different devices both survive: the whole reason for
  -- moving from a document merge to rows
  do $$ begin perform sync_diary('{"2026-09-15": {"updatedAt": 10, "meals": {"Lunch": []}}}'::jsonb); end $$;
  do $$ begin
    assert (select count(*) from days) = 2, 'a second day must not displace the first';
  end $$;

  -- junk keys are skipped rather than aborting the batch around them
  do $$ begin perform sync_diary('{"not-a-date": {"updatedAt": 9, "meals": {}},
                     "2026-09-16": {"updatedAt": 9, "meals": {"Lunch": []}}}'::jsonb); end $$;
  do $$ begin
    assert (select count(*) from days) = 3, 'a bad key must not lose the good day beside it';
  end $$;

  \echo '  ok: days merge newest-wins, per row'

  -- weights and settings follow the same rule
  do $$ begin perform sync_diary('{}'::jsonb, '{"2026-09-14": {"updatedAt": 100, "value": 82.5}}'::jsonb); end $$;
  do $$ begin perform sync_diary('{}'::jsonb, '{"2026-09-14": {"updatedAt": 50,  "value": 99.9}}'::jsonb); end $$;
  do $$ begin
    assert (select kg from weights) = 82.5, 'a stale weight must not overwrite';
  end $$;

  do $$ begin perform sync_diary('{}'::jsonb, '{}'::jsonb,
                    '{"updatedAt": 100, "value": {"goal": 2200}}'::jsonb); end $$;
  do $$ begin perform sync_diary('{}'::jsonb, '{}'::jsonb,
                    '{"updatedAt": 40,  "value": {"goal": 1500}}'::jsonb); end $$;
  do $$ begin
    assert (select value ->> 'goal' from settings) = '2200', 'a stale goal must not overwrite';
  end $$;
  \echo '  ok: weights and settings merge the same way'
rollback;

\echo '— one person cannot reach the other —'

begin;
  set local role authenticated;

  do $$ begin perform test_as('11111111-1111-1111-1111-111111111111'); end $$;
  do $$ begin perform sync_diary('{"2026-09-14": {"updatedAt": 1, "meals": {"Dinner": [{"k": 700}]}}}'::jsonb); end $$;

  do $$ begin perform test_as('22222222-2222-2222-2222-222222222222'); end $$;

  do $$
  declare n int; doc jsonb;
  begin
    select count(*) into n from days;
    assert n = 0, format('Claire can see %s of Mark''s days — RLS is not doing its job', n);

    -- and the sync call returns her empty diary, not his
    doc := sync_diary('{}'::jsonb);
    assert doc -> 'days' = '{}'::jsonb, 'sync must not leak the other diary: ' || doc::text;
  end $$;

  -- nor by aiming directly at his rows
  do $$
  declare n int;
  begin
    update days set meals = '{"Dinner": []}'::jsonb
      where user_id = '11111111-1111-1111-1111-111111111111';
    get diagnostics n = row_count;
    assert n = 0, 'Claire managed to update Mark''s day';

    delete from days where user_id = '11111111-1111-1111-1111-111111111111';
    get diagnostics n = row_count;
    assert n = 0, 'Claire managed to delete Mark''s day';
  end $$;

  -- and she cannot file a row under his id
  do $$ begin
    begin
      insert into days (user_id, date, meals, updated_at)
      values ('11111111-1111-1111-1111-111111111111', '2026-01-01', '{}'::jsonb, 1);
      assert false, 'Claire managed to write a day into Mark''s diary';
    exception when insufficient_privilege then
      null;  -- expected
    end;
  end $$;
  \echo '  ok: diaries are private, in both directions'
rollback;

\echo '— the food library is shared —'

begin;
  set local role authenticated;

  do $$ begin perform test_as('11111111-1111-1111-1111-111111111111'); end $$;
  do $$ begin perform sync_foods('{"c_lasagne": {"updatedAt": 100, "food": {"name": "Mum''s lasagne", "per100": {"k": 180}}}}'::jsonb); end $$;

  do $$ begin perform test_as('22222222-2222-2222-2222-222222222222'); end $$;
  do $$
  declare doc jsonb;
  begin
    doc := sync_foods('{}'::jsonb);
    assert doc -> 'foods' -> 'c_lasagne' -> 'food' ->> 'name' = 'Mum''s lasagne',
      'a shared food should be visible to the household: ' || doc::text;
  end $$;

  -- a tombstone from one device removes it for everyone
  do $$ begin perform sync_foods('{"c_lasagne": {"updatedAt": 200, "deleted": true}}'::jsonb); end $$;
  do $$ begin
    assert (select deleted from foods where id = 'c_lasagne'), 'delete should have landed';
  end $$;

  -- ...and a device that has been offline since before the delete must not
  -- bring it back
  do $$ begin perform test_as('11111111-1111-1111-1111-111111111111'); end $$;
  do $$ begin perform sync_foods('{"c_lasagne": {"updatedAt": 100, "food": {"name": "Mum''s lasagne"}}}'::jsonb); end $$;
  do $$ begin
    assert (select deleted from foods where id = 'c_lasagne'),
      'a stale device resurrected a deleted food';
  end $$;
  \echo '  ok: shared, and deletions stick'
rollback;

\echo '— active energy is read-only to clients (Model A) —'

begin;
  set local role authenticated;
  do $$ begin perform test_as('11111111-1111-1111-1111-111111111111'); end $$;

  -- the edge function writes as service_role, which bypasses RLS
  set local role postgres;
  insert into activity (user_id, date, kcal, updated_at)
  values ('11111111-1111-1111-1111-111111111111', '2026-09-14', 612, 100);

  set local role authenticated;
  do $$ begin perform test_as('11111111-1111-1111-1111-111111111111'); end $$;

  do $$
  declare doc jsonb;
  begin
    doc := sync_diary('{}'::jsonb);
    assert doc -> 'activity' -> '2026-09-14' ->> 'value' = '612',
      'the owner should get their activity back: ' || doc::text;
  end $$;

  -- but a syncing client must not be able to touch it
  do $$
  declare n int;
  begin
    update activity set kcal = 0 where user_id = '11111111-1111-1111-1111-111111111111';
    get diagnostics n = row_count;
    assert n = 0, 'a client managed to overwrite watch data';

    delete from activity where user_id = '11111111-1111-1111-1111-111111111111';
    get diagnostics n = row_count;
    assert n = 0, 'a client managed to delete watch data';
  end $$;

  do $$ begin
    begin
      insert into activity (user_id, date, kcal, updated_at)
      values ('11111111-1111-1111-1111-111111111111', '2026-09-20', 5000, 1);
      assert false, 'a client managed to invent watch data';
    exception when insufficient_privilege then
      null;  -- expected
    end;
  end $$;

  -- and Claire cannot read his
  do $$ begin perform test_as('22222222-2222-2222-2222-222222222222'); end $$;
  do $$ begin
    assert (select count(*) from activity) = 0, 'activity leaked across accounts';
  end $$;
  \echo '  ok: readable by its owner, writable by nobody but the function'
rollback;

\echo '— device keys —'

begin;
  set local role authenticated;
  do $$ begin perform test_as('11111111-1111-1111-1111-111111111111'); end $$;

  do $$
  declare raw text; stored text;
  begin
    raw := issue_device_key('iPhone');
    assert raw like 'tk_%' and length(raw) = 51, 'unexpected key shape: ' || raw;

    select key_hash into stored from device_keys limit 1;
    assert stored <> raw, 'the raw key must not be stored';
    assert stored = encode(extensions.digest(raw, 'sha256'), 'hex'), 'stored hash should match the key';

    -- two calls never collide
    assert issue_device_key('iPad') <> raw, 'keys must be unique';
  end $$;

  -- Claire cannot see Mark's keys
  do $$ begin perform test_as('22222222-2222-2222-2222-222222222222'); end $$;
  do $$ begin
    assert (select count(*) from device_keys) = 0, 'device keys leaked across accounts';
  end $$;
  \echo '  ok: issued once, stored hashed, scoped to their owner'
rollback;

\echo '— signed out gets nothing —'

begin;
  set local role authenticated;
  do $$ begin perform set_config('request.jwt.claim.sub', '', true); end $$;

  do $$ begin
    begin
      perform sync_diary('{"2026-09-14": {"updatedAt": 1, "meals": {}}}'::jsonb);
      assert false, 'sync_diary ran without a user';
    exception when invalid_authorization_specification then
      null;  -- expected
    end;
    begin
      perform sync_foods('{}'::jsonb);
      assert false, 'sync_foods ran without a user';
    exception when invalid_authorization_specification then
      null;  -- expected
    end;
  end $$;
  \echo '  ok: refused'
rollback;

\echo ''
\echo 'All schema tests passed.'
