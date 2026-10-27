-- RPCs for actions that cross RLS boundaries. Each checks the caller itself.

create function public.join_group(p_token text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_group uuid;
  v_slug text;
  v_current uuid;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  select i.group_id, g.slug into v_group, v_slug
  from public.group_invites i
  join public.groups g on g.id = i.group_id
  where i.token = p_token;
  if v_group is null then
    raise exception 'invalid or expired invite link' using errcode = 'P0002';
  end if;
  select m.group_id into v_current from public.group_members m where m.user_id = v_uid;
  if v_current = v_group then
    return v_slug;
  end if;
  if v_current is not null then
    raise exception 'you are already in another group' using errcode = '23505';
  end if;
  insert into public.group_members (group_id, user_id) values (v_group, v_uid);
  return v_slug;
end;
$$;

create function public.rotate_invite(p_group uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
begin
  if not private.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  insert into public.group_invites (group_id) values (p_group)
  on conflict (group_id) do update
    set token = encode(extensions.gen_random_bytes(24), 'hex'), rotated_at = now()
  returning token into v_token;
  return v_token;
end;
$$;

create function public.set_admin(p_user uuid, p_value boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if p_user = auth.uid() and not p_value then
    raise exception 'you cannot remove your own admin access' using errcode = '42501';
  end if;
  update public.profiles set is_admin = p_value where id = p_user;
  if not found then
    raise exception 'unknown user' using errcode = 'P0002';
  end if;
end;
$$;

create function public.set_active_submission(p_lobby uuid, p_submission uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid;
begin
  select s.group_id into v_group from public.submissions s where s.id = p_submission;
  if v_group is null or not private.is_member(v_group) then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  update public.lobby_entries set active_submission_id = p_submission
  where lobby_id = p_lobby and group_id = v_group;
  if not found then
    raise exception 'your group is not entered in this lobby' using errcode = 'P0002';
  end if;
end;
$$;

-- Teammates' display names without exposing emails.
create function public.get_group_roster(p_group uuid)
returns table (user_id uuid, display_name text, avatar_url text, joined_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name, p.avatar_url, m.joined_at
  from public.group_members m
  join public.profiles p on p.id = m.user_id
  where m.group_id = p_group and (private.is_member(p_group) or private.is_admin())
  order by m.joined_at
$$;

revoke all on function public.join_group(text) from public, anon;
revoke all on function public.rotate_invite(uuid) from public, anon;
revoke all on function public.set_admin(uuid, boolean) from public, anon;
revoke all on function public.set_active_submission(uuid, uuid) from public, anon;
revoke all on function public.get_group_roster(uuid) from public, anon;
grant execute on function public.join_group(text) to authenticated;
grant execute on function public.rotate_invite(uuid) to authenticated;
grant execute on function public.set_admin(uuid, boolean) to authenticated;
grant execute on function public.set_active_submission(uuid, uuid) to authenticated;
grant execute on function public.get_group_roster(uuid) to authenticated;
