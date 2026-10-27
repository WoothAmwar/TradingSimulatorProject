-- Single-runner guarantee for lobby tick loops. During a Render deploy two engine instances
-- overlap briefly; only the lease holder may advance a lobby. Leases expire unless renewed, so a
-- crashed instance is replaced after the TTL. Only the engine (service_role) can call these.

create table public.engine_leases (
  lobby_id uuid primary key references public.lobbies (id) on delete cascade,
  holder text not null,
  expires_at timestamptz not null
);
alter table public.engine_leases enable row level security;
revoke all on public.engine_leases from anon, authenticated;

-- Claims or renews the lease; true if `p_holder` holds it afterwards.
create function public.claim_lobby_lease(p_lobby uuid, p_holder text, p_ttl_seconds int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_holder text;
begin
  insert into public.engine_leases as l (lobby_id, holder, expires_at)
  values (p_lobby, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (lobby_id) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where l.holder = excluded.holder or l.expires_at < now()
  returning holder into v_holder;
  return v_holder is not null;
end;
$$;

create function public.release_lobby_lease(p_lobby uuid, p_holder text) returns void
language sql security definer set search_path = '' as $$
  delete from public.engine_leases where lobby_id = p_lobby and holder = p_holder
$$;

revoke all on function public.claim_lobby_lease(uuid, text, int) from public, anon, authenticated;
revoke all on function public.release_lobby_lease(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_lobby_lease(uuid, text, int) to service_role;
grant execute on function public.release_lobby_lease(uuid, text) to service_role;
