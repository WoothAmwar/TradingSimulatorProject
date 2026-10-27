-- Lets the join page show which group an invite link is for before the user confirms.
create function public.peek_invite(p_token text)
returns table (name text, slug text)
language sql stable security definer set search_path = '' as $$
  select g.name, g.slug
  from public.group_invites i
  join public.groups g on g.id = i.group_id
  where i.token = p_token and auth.uid() is not null
$$;

revoke all on function public.peek_invite(text) from public, anon;
grant execute on function public.peek_invite(text) to authenticated;
