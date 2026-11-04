-- The live leaderboard's "last 300 ticks" and "per tick" columns need each group's recent scores
-- when a page opens mid-round. Scores are already public on the engine feed; cash and positions
-- stay private (pnl_snapshots RLS). One row per group, so PostgREST's row limit never cuts it off.

create function public.lobby_score_history(p_lobby uuid, p_ticks int)
returns table (group_id uuid, ticks int[], pnls float8[])
language sql stable security definer set search_path = '' as $$
  select s.group_id, array_agg(s.tick order by s.tick), array_agg(s.pnl::float8 order by s.tick)
  from public.pnl_snapshots s
  join public.lobbies l on l.id = s.lobby_id
  where s.lobby_id = p_lobby
    and (l.status <> 'draft' or private.is_admin())
    and s.tick >= l.current_tick - least(greatest(p_ticks, 0), 5000)
  group by s.group_id
$$;

revoke all on function public.lobby_score_history(uuid, int) from public;
grant execute on function public.lobby_score_history(uuid, int) to anon, authenticated;
