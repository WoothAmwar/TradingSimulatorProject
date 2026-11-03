-- Invite links carried 48 hex characters, too long to type. Invites are now 8-character codes in
-- Crockford's base 32 (digits and capitals without I, L, O and U), shown as K7QM-X2PD: 32^8 is
-- about 10^12 codes, and joining needs a signed-in account. Typed codes are forgiving: case,
-- dashes and spaces are ignored, and O, I and L are read as 0, 1 and 1. Existing links stop
-- working; admins copy the new ones from the home page.

create function private.new_invite_code() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (get_byte(r.b, g.i) & 31) + 1, 1), '' order by g.i)
  from (select extensions.gen_random_bytes(8) as b) r, generate_series(0, 7) as g(i)
$$;

create function private.normalize_invite(p_code text) returns text
language sql immutable set search_path = '' as $$
  select translate(upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g')), 'OIL', '011')
$$;

revoke all on function private.new_invite_code() from public, anon, authenticated;
revoke all on function private.normalize_invite(text) from public, anon, authenticated;

alter table public.group_invites alter column token set default private.new_invite_code();
update public.group_invites set token = private.new_invite_code(), rotated_at = now();

-- Unchanged from 20261027000200_rpcs except for the new code.
create or replace function public.rotate_invite(p_group uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
begin
  if not private.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  insert into public.group_invites (group_id) values (p_group)
  on conflict (group_id) do update
    set token = private.new_invite_code(), rotated_at = now()
  returning token into v_token;
  return v_token;
end;
$$;

-- Unchanged from 20261027000200_rpcs except that the typed code is normalized.
create or replace function public.join_group(p_token text) returns text
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
  where i.token = private.normalize_invite(p_token);
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

-- Unchanged from 20261027000400_peek_invite except that the typed code is normalized.
create or replace function public.peek_invite(p_token text)
returns table (name text, slug text)
language sql stable security definer set search_path = '' as $$
  select g.name, g.slug
  from public.group_invites i
  join public.groups g on g.id = i.group_id
  where i.token = private.normalize_invite(p_token) and auth.uid() is not null
$$;
