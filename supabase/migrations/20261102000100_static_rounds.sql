-- Static rounds: markets generated once and published in full, run alongside live lobbies.
--
-- A static round is a lobby with kind = 'static'. Its status means: scheduled = data published
-- (backtests work, scoring closed), running = open for scores, paused = scoring paused,
-- finished = closed. Every group may take part, so there are no lobby_entries. Groups write
-- separate code for each static round (submissions.lobby_id), run it in the browser and report the
-- score through submit_round_score(). The latest score counts and lands in lobby_results, which
-- already backs the public leaderboards; every attempt is also kept in round_attempts.

create type public.round_kind as enum ('live', 'static');

alter table public.lobbies add column kind public.round_kind not null default 'live';

-- null: code for live lobbies. Otherwise the static round the code was written for.
alter table public.submissions
  add column lobby_id uuid references public.lobbies (id) on delete cascade;
create index submissions_lobby_idx on public.submissions (lobby_id);

-- Code may only target a static round the author can see (non-admins never see drafts).
alter policy submissions_insert on public.submissions
  with check (
    author_id = (select auth.uid())
    and private.is_member(group_id)
    and (
      submissions.lobby_id is null
      or exists (
        select 1 from public.lobbies l where l.id = submissions.lobby_id and l.kind = 'static'
      )
    )
  );

create table public.round_attempts (
  id bigint generated always as identity primary key,
  lobby_id uuid not null references public.lobbies (id) on delete cascade,
  group_id uuid not null references public.groups (id) on delete cascade,
  submission_id uuid references public.submissions (id) on delete set null,
  user_id uuid references public.profiles (id) on delete set null,
  score numeric not null,
  ticks int not null,
  fills int not null,
  created_at timestamptz not null default now()
);
create index round_attempts_lobby_group_idx
  on public.round_attempts (lobby_id, group_id, created_at desc);
create index round_attempts_group_idx on public.round_attempts (group_id);
create index round_attempts_submission_idx on public.round_attempts (submission_id);
create index round_attempts_user_idx on public.round_attempts (user_id);

alter table public.round_attempts enable row level security;
revoke all on public.round_attempts from anon, authenticated;
grant select on public.round_attempts to authenticated;
create policy round_attempts_select on public.round_attempts for select to authenticated
  using (private.is_member(group_id) or (select private.is_admin()));

-- Records a group's score for an open static round and returns the group's new rank. The score is
-- computed by the group's browser; the submission it came from is kept for auditing.
create function public.submit_round_score(
  p_lobby uuid, p_submission uuid, p_score numeric, p_ticks int, p_fills int
) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_kind public.round_kind;
  v_status public.lobby_status;
  v_group uuid;
  v_ticks int;
  v_rank int;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  -- Locking the round serialises concurrent submissions while ranks are recomputed.
  select l.kind, l.status into v_kind, v_status
  from public.lobbies l where l.id = p_lobby for update;
  if v_kind is distinct from 'static' then
    raise exception 'static round not found' using errcode = 'P0002';
  end if;
  if v_status <> 'running' then
    raise exception 'this round is not accepting scores right now' using errcode = '55000';
  end if;
  select s.group_id into v_group
  from public.submissions s where s.id = p_submission and s.lobby_id = p_lobby;
  if v_group is null or not private.is_member(v_group) then
    raise exception 'submission not found for this round' using errcode = 'P0002';
  end if;
  select d.ticks into v_ticks from public.datasets d where d.lobby_id = p_lobby;
  if p_ticks is distinct from v_ticks then
    raise exception 'the backtest must run all % ticks of the round', v_ticks
      using errcode = '22023';
  end if;
  if p_score is null or p_score = 'NaN'::numeric or abs(p_score) >= 1e12
     or p_fills is null or p_fills < 0 then
    raise exception 'invalid score' using errcode = '22023';
  end if;

  insert into public.round_attempts (lobby_id, group_id, submission_id, user_id, score, ticks, fills)
  values (p_lobby, v_group, p_submission, v_uid, round(p_score, 4), p_ticks, p_fills);

  insert into public.lobby_results (lobby_id, group_id, final_pnl, rank)
  values (p_lobby, v_group, round(p_score, 4), 0)
  on conflict (lobby_id, group_id) do update set final_pnl = excluded.final_pnl;
  update public.lobby_results r set rank = x.new_rank
  from (
    select o.group_id, (rank() over (order by o.final_pnl desc))::int as new_rank
    from public.lobby_results o where o.lobby_id = p_lobby
  ) x
  where r.lobby_id = p_lobby and r.group_id = x.group_id;

  select r.rank into v_rank
  from public.lobby_results r where r.lobby_id = p_lobby and r.group_id = v_group;
  return v_rank;
end;
$$;

-- Live lobbies run live code only: static-round code and static rounds are refused.
create or replace function public.set_active_submission(p_lobby uuid, p_submission uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid;
begin
  select s.group_id into v_group
  from public.submissions s where s.id = p_submission and s.lobby_id is null;
  if v_group is null or not private.is_member(v_group) then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  update public.lobby_entries e set active_submission_id = p_submission
  where e.lobby_id = p_lobby and e.group_id = v_group
    and exists (select 1 from public.lobbies l where l.id = p_lobby and l.kind = 'live');
  if not found then
    raise exception 'your group is not entered in this lobby' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.submit_round_score(uuid, uuid, numeric, int, int) from public, anon;
grant execute on function public.submit_round_score(uuid, uuid, numeric, int, int)
  to authenticated;
