-- RLS smoke test. Creates throwaway users/groups, impersonates them, and always aborts with the
-- collected results, so nothing is persisted. Expected output is listed next to each check.
do $$
declare
  alice uuid := gen_random_uuid();   -- member of team A
  bob uuid := gen_random_uuid();     -- member of team B
  carol uuid := gen_random_uuid();   -- not in a group yet
  admin uuid := gen_random_uuid();
  ga uuid;
  gb uuid;
  lobby uuid;
  open_lobby uuid;
  round_open uuid;    -- static round accepting scores
  round_draft uuid;   -- static round not published yet
  sub_a uuid;         -- team A's code for round_open
  sub_b uuid;         -- team B's code for round_open
  files text[];
  token_a text;
  token_b text;
  n int;
  r text := '';
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role) values
    (alice, 'alice@test.dev', '{"full_name":"Alice"}', 'authenticated', 'authenticated'),
    (bob, 'bob@test.dev', '{"full_name":"Bob"}', 'authenticated', 'authenticated'),
    (carol, 'carol@test.dev', '{"full_name":"Carol"}', 'authenticated', 'authenticated'),
    (admin, 'admin@test.dev', '{"full_name":"Admin"}', 'authenticated', 'authenticated');
  update public.profiles set is_admin = true where id = admin;
  insert into public.groups (slug, name) values ('team-a', 'Team A') returning id into ga;
  insert into public.groups (slug, name) values ('team-b', 'Team B') returning id into gb;
  select token into token_a from public.group_invites where group_id = ga;
  select token into token_b from public.group_invites where group_id = gb;
  insert into public.group_members (group_id, user_id) values (ga, alice), (gb, bob);
  insert into public.submissions (group_id, author_id, source) values
    (ga, alice, 'print("a")'), (gb, bob, 'print("b")');
  insert into public.lobbies (name, status) values ('Draft lobby', 'draft') returning id into lobby;
  insert into public.lobby_secrets (lobby_id, model_config) values (lobby, '{}');
  insert into public.lobbies (name, status) values ('Open lobby', 'scheduled') returning id into open_lobby;
  insert into public.lobbies (name, status, kind) values ('Static open', 'running', 'static')
    returning id into round_open;
  insert into public.lobbies (name, status, kind) values ('Static draft', 'draft', 'static')
    returning id into round_draft;
  insert into public.datasets (lobby_id, ticks, manifest) values (round_open, 100, '{}');
  insert into public.submissions (group_id, author_id, source, lobby_id)
    values (ga, alice, 'a', round_open) returning id into sub_a;
  insert into public.submissions (group_id, author_id, source, lobby_id)
    values (gb, bob, 'b', round_open) returning id into sub_b;
  insert into public.lobby_entries (lobby_id, group_id) values (open_lobby, ga);
  files := array[lobby || '/manifest.json', open_lobby || '/manifest.json'];
  insert into storage.objects (bucket_id, name) select 'datasets', unnest(files);

  -- Alice ------------------------------------------------------------------------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', alice, 'role', 'authenticated')::text, true);
  select count(*) into n from public.submissions;            r := r || ' alice.subs=' || n;      -- 2 (live + round code)
  select count(*) into n from public.submissions where group_id = gb; r := r || ' alice.subsB=' || n; -- 0
  select count(*) into n from public.profiles;               r := r || ' alice.profiles=' || n;  -- 1
  select count(*) into n from public.group_members;          r := r || ' alice.members=' || n;   -- 1
  select count(*) into n from public.group_invites;          r := r || ' alice.invites=' || n;   -- 0
  select count(*) into n from public.lobby_secrets;          r := r || ' alice.secrets=' || n;   -- 0
  select count(*) into n from public.lobbies where id in (lobby, open_lobby); r := r || ' alice.lobbies=' || n;   -- 1
  select count(*) into n from public.get_group_roster(gb);   r := r || ' alice.rosterB=' || n;   -- 0
  select count(*) into n from public.get_group_roster(ga);   r := r || ' alice.rosterA=' || n;   -- 1
  select count(*) into n from storage.objects where name = any(files); r := r || ' alice.datasets=' || n; -- 1 (not the draft's)
  begin
    insert into public.submissions (group_id, source) values (gb, 'x');
    r := r || ' alice.insertB=ALLOWED';
  exception when others then r := r || ' alice.insertB=denied'; end;
  begin
    insert into public.submissions (group_id, source) values (ga, 'ok');
    r := r || ' alice.insertA=ok';
  exception when others then r := r || ' alice.insertA=FAILED:' || sqlerrm; end;
  begin
    insert into public.submissions (group_id, source, lobby_id) values (ga, 'x', open_lobby);
    r := r || ' alice.codeForLive=ALLOWED';
  exception when others then r := r || ' alice.codeForLive=denied'; end;
  begin
    insert into public.submissions (group_id, source, lobby_id) values (ga, 'x', round_draft);
    r := r || ' alice.codeForDraft=ALLOWED';
  exception when others then r := r || ' alice.codeForDraft=denied'; end;
  begin
    insert into public.submissions (group_id, source, lobby_id) values (ga, 'ok', round_open);
    r := r || ' alice.codeForRound=ok';
  exception when others then r := r || ' alice.codeForRound=FAILED:' || sqlerrm; end;
  r := r || ' alice.score=' || public.submit_round_score(round_open, sub_a, 50, 100, 2);   -- 1
  begin
    perform public.submit_round_score(round_open, sub_b, 999, 100, 2);
    r := r || ' alice.scoreB=ALLOWED';
  exception when others then r := r || ' alice.scoreB=denied'; end;
  begin
    perform public.submit_round_score(round_open, sub_a, 50, 99, 2);
    r := r || ' alice.partialRun=ALLOWED';
  exception when others then r := r || ' alice.partialRun=denied'; end;
  begin
    perform public.submit_round_score(open_lobby, sub_a, 50, 100, 2);
    r := r || ' alice.scoreLive=ALLOWED';
  exception when others then r := r || ' alice.scoreLive=denied'; end;
  begin
    perform public.set_active_submission(open_lobby, sub_a);
    r := r || ' alice.activateRoundCode=ALLOWED';
  exception when others then r := r || ' alice.activateRoundCode=denied'; end;
  begin
    update public.profiles set is_admin = true where id = alice;
    r := r || ' alice.selfPromote=ALLOWED';
  exception when others then r := r || ' alice.selfPromote=denied'; end;
  begin
    perform public.set_admin(alice, true);
    r := r || ' alice.setAdmin=ALLOWED';
  exception when others then r := r || ' alice.setAdmin=denied'; end;
  begin
    perform public.join_group(token_b);
    r := r || ' alice.joinB=ALLOWED';
  exception when others then r := r || ' alice.joinB=denied'; end;
  begin
    insert into public.groups (slug, name) values ('rogue', 'Rogue');
    r := r || ' alice.createGroup=ALLOWED';
  exception when others then r := r || ' alice.createGroup=denied'; end;

  -- Carol joins team B with its invite token ------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', carol, 'role', 'authenticated')::text, true);
  r := r || ' carol.join=' || public.join_group(token_b);                                         -- team-b
  select count(*) into n from public.submissions;            r := r || ' carol.subs=' || n;      -- 2 (B's)
  r := r || ' carol.score=' || public.submit_round_score(round_open, sub_b, 80, 100, 3);   -- 1
  r := r || ' carol.rescore=' || public.submit_round_score(round_open, sub_b, 10, 100, 1); -- 2 (latest counts)
  select count(*) into n from public.round_attempts;         r := r || ' carol.attempts=' || n;  -- 2 (B's)
  begin
    perform public.join_group('not-a-token');
    r := r || ' carol.badToken=ALLOWED';
  exception when others then r := r || ' carol.badToken=denied'; end;

  -- Admin ------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', admin, 'role', 'authenticated')::text, true);
  select count(*) into n from public.lobby_secrets where lobby_id = lobby; r := r || ' admin.secrets=' || n;   -- 1
  select count(*) into n from public.lobbies where id in (lobby, open_lobby); r := r || ' admin.lobbies=' || n;   -- 2
  select count(*) into n from public.group_invites where group_id in (ga, gb); r := r || ' admin.invites=' || n;   -- 2
  select count(*) into n from storage.objects where name = any(files); r := r || ' admin.datasets=' || n; -- 2
  select count(*) into n from public.round_attempts where lobby_id = round_open; r := r || ' admin.attempts=' || n; -- 3

  -- Anonymous --------------------------------------------------------------------------------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into n from public.groups where id in (ga, gb); r := r || ' anon.groups=' || n;     -- 2
  select count(*) into n from public.lobbies where id in (lobby, open_lobby); r := r || ' anon.lobbies=' || n;    -- 1
  select count(*) into n from storage.objects where name = any(files); r := r || ' anon.datasets=' || n; -- 0
  select count(*) into n from public.lobby_results where lobby_id = round_open; r := r || ' anon.roundResults=' || n; -- 2
  begin
    select count(*) into n from public.round_attempts;
    r := r || ' anon.attempts=ALLOWED';
  exception when others then r := r || ' anon.attempts=denied'; end;
  begin
    select count(*) into n from public.submissions;
    r := r || ' anon.subs=ALLOWED';
  exception when others then r := r || ' anon.subs=denied'; end;
  begin
    select count(*) into n from public.profiles;
    r := r || ' anon.profiles=ALLOWED';
  exception when others then r := r || ' anon.profiles=denied'; end;

  raise exception 'RLS RESULTS:%', r;
end $$;
