-- A finished lobby's active submission is the record of what competed, so members can no longer
-- change it once the lobby has finished. The engine stores results before it marks the lobby
-- finished, so results existing counts as finished too. FOR SHARE orders the check against a
-- concurrent status update. Otherwise unchanged from 20261102000100_static_rounds.

create or replace function public.set_active_submission(p_lobby uuid, p_submission uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid;
  v_status public.lobby_status;
begin
  select s.group_id into v_group
  from public.submissions s where s.id = p_submission and s.lobby_id is null;
  if v_group is null or not private.is_member(v_group) then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select l.status into v_status from public.lobbies l where l.id = p_lobby for share;
  if v_status = 'finished' or exists (select 1 from public.lobby_results r where r.lobby_id = p_lobby) then
    raise exception 'this lobby has finished' using errcode = '55000';
  end if;
  update public.lobby_entries e set active_submission_id = p_submission
  where e.lobby_id = p_lobby and e.group_id = v_group
    and exists (select 1 from public.lobbies l where l.id = p_lobby and l.kind = 'live');
  if not found then
    raise exception 'your group is not entered in this lobby' using errcode = 'P0002';
  end if;
end;
$$;
