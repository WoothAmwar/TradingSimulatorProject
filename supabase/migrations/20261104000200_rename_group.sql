-- Groups may rename themselves (admins may rename any group). The slug stays, so the group's
-- page URL and links to it keep working. Names are unique ignoring case, so a leaderboard never
-- shows two groups with the same name; the index also covers groups admins create.

create unique index groups_name_key on public.groups (lower(name));

create function public.rename_group(p_group uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if not (private.is_member(p_group) or private.is_admin()) then
    raise exception 'group not found' using errcode = 'P0002';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'a group name is 1 to 60 characters' using errcode = '23514';
  end if;
  update public.groups set name = v_name where id = p_group;
  if not found then
    raise exception 'group not found' using errcode = 'P0002';
  end if;
exception when unique_violation then
  raise exception 'another group is already called "%"', v_name using errcode = '23505';
end;
$$;

revoke all on function public.rename_group(uuid, text) from public, anon;
grant execute on function public.rename_group(uuid, text) to authenticated;
