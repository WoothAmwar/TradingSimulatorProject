-- Core schema: identities, groups, code submissions, lobbies and engine output.
--
-- Every table has RLS enabled. This project's default ACL grants everything on new tables and
-- functions to anon/authenticated, so each object starts from a full revoke and only the
-- privileges the web app needs are granted back. The engine connects as `postgres`, which
-- bypasses RLS, and is the only writer of engine-output tables.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

create type public.lobby_status as enum ('draft', 'scheduled', 'running', 'paused', 'finished');
create type public.bot_language as enum ('python', 'java', 'c', 'cpp', 'go');

-- 128-bit lobby seed from pgcrypto's CSPRNG.
create function private.random_seed() returns numeric
language sql volatile set search_path = '' as $$
  select sum(get_byte(r.b, i)::numeric * power(256::numeric, 15 - i))
  from (select extensions.gen_random_bytes(16) as b) r, generate_series(0, 15) as i
$$;

-- Identities -----------------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text check (char_length(display_name) <= 60),
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.admin_allowlist (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

-- Groups ---------------------------------------------------------------------------------------

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  name text not null check (char_length(name) between 1 and 60),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index groups_created_by_idx on public.groups (created_by);

create table public.group_invites (
  group_id uuid primary key references public.groups (id) on delete cascade,
  token text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  rotated_at timestamptz not null default now()
);

-- user_id is unique: a user belongs to at most one group.
create table public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- Code -----------------------------------------------------------------------------------------

-- Immutable once inserted: saving again creates a new row.
create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  author_id uuid default auth.uid() references public.profiles (id) on delete set null,
  language public.bot_language not null default 'python',
  title text not null default 'Untitled' check (char_length(title) between 1 and 80),
  source text not null check (octet_length(source) <= 200000),
  source_sha256 text,
  created_at timestamptz not null default now()
);
create index submissions_group_created_idx on public.submissions (group_id, created_at desc);
create index submissions_author_idx on public.submissions (author_id);

-- Lobbies --------------------------------------------------------------------------------------

-- public_config holds what participants may see (goods, limits, tick_ms, dataset_ticks, ...).
create table public.lobbies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  status public.lobby_status not null default 'draft',
  public_config jsonb not null default '{}'::jsonb,
  max_groups int not null default 20 check (max_groups between 1 and 200),
  current_tick int,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index lobbies_created_by_idx on public.lobbies (created_by);

-- The seed and price-model parameters never leave admins and the engine.
create table public.lobby_secrets (
  lobby_id uuid primary key references public.lobbies (id) on delete cascade,
  seed numeric(39, 0) not null default private.random_seed()
    check (seed >= 0 and seed < 2::numeric ^ 128),
  model_config jsonb not null
);

create table public.lobby_entries (
  lobby_id uuid not null references public.lobbies (id) on delete cascade,
  group_id uuid not null references public.groups (id) on delete cascade,
  active_submission_id uuid references public.submissions (id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (lobby_id, group_id)
);
create index lobby_entries_group_idx on public.lobby_entries (group_id);
create index lobby_entries_submission_idx on public.lobby_entries (active_submission_id);

-- Files live in the `datasets` storage bucket under <lobby_id>/.
create table public.datasets (
  lobby_id uuid primary key references public.lobbies (id) on delete cascade,
  ticks int not null,
  manifest jsonb not null,
  created_at timestamptz not null default now()
);

-- Engine output --------------------------------------------------------------------------------

create table public.market_snapshots (
  lobby_id uuid not null references public.lobbies (id) on delete cascade,
  tick int not null,
  good text not null,
  best_bid int,
  best_ask int,
  mid numeric,
  last_price int,
  volume int not null default 0,
  primary key (lobby_id, good, tick)
);

create table public.participant_fills (
  id bigint generated always as identity primary key,
  lobby_id uuid not null references public.lobbies (id) on delete cascade,
  tick int not null,
  good text not null,
  price int not null,
  qty int not null check (qty > 0),
  buyer_group uuid references public.groups (id) on delete cascade,
  seller_group uuid references public.groups (id) on delete cascade,
  aggressor smallint not null check (aggressor in (-1, 1)),
  check (buyer_group is not null or seller_group is not null)
);
create index participant_fills_lobby_tick_idx on public.participant_fills (lobby_id, tick);
create index participant_fills_buyer_idx on public.participant_fills (buyer_group);
create index participant_fills_seller_idx on public.participant_fills (seller_group);

-- Every participant batch, so a crashed engine can rebuild state by deterministic replay.
create table public.order_batches (
  lobby_id uuid not null references public.lobbies (id) on delete cascade,
  tick int not null,
  group_id uuid not null references public.groups (id) on delete cascade,
  actions jsonb not null,
  primary key (lobby_id, tick, group_id)
);
create index order_batches_group_idx on public.order_batches (group_id);

-- Positions are private to the group; the public leaderboard comes from the engine feed.
create table public.pnl_snapshots (
  lobby_id uuid not null references public.lobbies (id) on delete cascade,
  group_id uuid not null references public.groups (id) on delete cascade,
  tick int not null,
  cash bigint not null,
  positions jsonb not null,
  pnl numeric not null,
  primary key (lobby_id, group_id, tick)
);
create index pnl_snapshots_group_idx on public.pnl_snapshots (group_id);

create table public.lobby_results (
  lobby_id uuid not null references public.lobbies (id) on delete cascade,
  group_id uuid not null references public.groups (id) on delete cascade,
  final_pnl numeric not null,
  rank int not null,
  primary key (lobby_id, group_id)
);
create index lobby_results_group_idx on public.lobby_results (group_id);

-- Helpers used by policies ---------------------------------------------------------------------

create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = (select auth.uid())), false
  )
$$;

create function private.is_member(p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = p_group and m.user_id = (select auth.uid())
  )
$$;

revoke all on function private.random_seed() from public, anon, authenticated;
revoke all on function private.is_admin() from public;
revoke all on function private.is_member(uuid) from public;
grant execute on function private.is_admin() to anon, authenticated, service_role;
grant execute on function private.is_member(uuid) to anon, authenticated, service_role;

-- Triggers -------------------------------------------------------------------------------------

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url, is_admin)
  values (
    new.id,
    lower(new.email),
    left(coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'user_name',
      split_part(new.email, '@', 1)
    ), 60),
    new.raw_user_meta_data ->> 'avatar_url',
    exists (select 1 from public.admin_allowlist a where a.email = lower(new.email))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create function private.create_group_invite() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.group_invites (group_id) values (new.id);
  return new;
end;
$$;

create trigger groups_create_invite
  after insert on public.groups
  for each row execute function private.create_group_invite();

create function private.submission_hash() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.source_sha256 := encode(sha256(convert_to(new.source, 'UTF8')), 'hex');
  return new;
end;
$$;

create trigger submissions_hash
  before insert on public.submissions
  for each row execute function private.submission_hash();

create function private.enforce_max_groups() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_max int;
  v_count int;
begin
  select l.max_groups into v_max from public.lobbies l where l.id = new.lobby_id for update;
  select count(*) into v_count from public.lobby_entries e where e.lobby_id = new.lobby_id;
  if v_count >= v_max then
    raise exception 'lobby is full (max % groups)', v_max using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger lobby_entries_max_groups
  before insert on public.lobby_entries
  for each row execute function private.enforce_max_groups();

revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.create_group_invite() from public, anon, authenticated;
revoke all on function private.submission_hash() from public, anon, authenticated;
revoke all on function private.enforce_max_groups() from public, anon, authenticated;

-- Privileges -----------------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;

grant select on public.groups, public.lobbies, public.lobby_entries, public.market_snapshots,
  public.lobby_results to anon;

grant select on all tables in schema public to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant insert, delete on public.admin_allowlist to authenticated;
grant insert, update, delete on public.groups to authenticated;
grant insert, update, delete on public.group_invites to authenticated;
grant insert, delete on public.group_members to authenticated;
grant insert, delete on public.submissions to authenticated;
grant insert, update, delete on public.lobbies to authenticated;
grant insert, update on public.lobby_secrets to authenticated;
grant insert, delete on public.lobby_entries to authenticated;

-- Row level security ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.admin_allowlist enable row level security;
alter table public.groups enable row level security;
alter table public.group_invites enable row level security;
alter table public.group_members enable row level security;
alter table public.submissions enable row level security;
alter table public.lobbies enable row level security;
alter table public.lobby_secrets enable row level security;
alter table public.lobby_entries enable row level security;
alter table public.datasets enable row level security;
alter table public.market_snapshots enable row level security;
alter table public.participant_fills enable row level security;
alter table public.order_batches enable row level security;
alter table public.pnl_snapshots enable row level security;
alter table public.lobby_results enable row level security;

-- profiles: yourself, or admins. Teammates' names come from get_group_roster().
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy admin_allowlist_select on public.admin_allowlist for select to authenticated
  using ((select private.is_admin()));
create policy admin_allowlist_insert on public.admin_allowlist for insert to authenticated
  with check ((select private.is_admin()));
create policy admin_allowlist_delete on public.admin_allowlist for delete to authenticated
  using ((select private.is_admin()));

-- groups: names are public (leaderboard); only admins manage them.
create policy groups_select on public.groups for select to anon, authenticated using (true);
create policy groups_insert on public.groups for insert to authenticated
  with check ((select private.is_admin()));
create policy groups_update on public.groups for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy groups_delete on public.groups for delete to authenticated
  using ((select private.is_admin()));

create policy group_invites_select on public.group_invites for select to authenticated
  using ((select private.is_admin()));
create policy group_invites_insert on public.group_invites for insert to authenticated
  with check ((select private.is_admin()));
create policy group_invites_update on public.group_invites for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy group_invites_delete on public.group_invites for delete to authenticated
  using ((select private.is_admin()));

-- group_members: joining goes through join_group(); members may leave.
create policy group_members_select on public.group_members for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_member(group_id)
    or (select private.is_admin())
  );
create policy group_members_insert on public.group_members for insert to authenticated
  with check ((select private.is_admin()));
create policy group_members_delete on public.group_members for delete to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

-- submissions: only your own group's code (admins can read everything for moderation).
create policy submissions_select on public.submissions for select to authenticated
  using (private.is_member(group_id) or (select private.is_admin()));
create policy submissions_insert on public.submissions for insert to authenticated
  with check (author_id = (select auth.uid()) and private.is_member(group_id));
create policy submissions_delete on public.submissions for delete to authenticated
  using (author_id = (select auth.uid()) or (select private.is_admin()));

-- lobbies: drafts are admin-only; everything else is public.
create policy lobbies_select on public.lobbies for select to anon, authenticated
  using (status <> 'draft' or (select private.is_admin()));
create policy lobbies_insert on public.lobbies for insert to authenticated
  with check ((select private.is_admin()));
create policy lobbies_update on public.lobbies for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy lobbies_delete on public.lobbies for delete to authenticated
  using ((select private.is_admin()));

create policy lobby_secrets_select on public.lobby_secrets for select to authenticated
  using ((select private.is_admin()));
create policy lobby_secrets_insert on public.lobby_secrets for insert to authenticated
  with check ((select private.is_admin()));
create policy lobby_secrets_update on public.lobby_secrets for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- Visible-lobby checks reuse the lobbies policy through the subquery.
create policy lobby_entries_select on public.lobby_entries for select to anon, authenticated
  using (exists (select 1 from public.lobbies l where l.id = lobby_id));
create policy lobby_entries_insert on public.lobby_entries for insert to authenticated
  with check ((select private.is_admin()));
create policy lobby_entries_delete on public.lobby_entries for delete to authenticated
  using ((select private.is_admin()));

create policy datasets_select on public.datasets for select to authenticated
  using (exists (select 1 from public.lobbies l where l.id = lobby_id));

create policy market_snapshots_select on public.market_snapshots for select to anon, authenticated
  using (exists (select 1 from public.lobbies l where l.id = lobby_id));

create policy participant_fills_select on public.participant_fills for select to authenticated
  using (
    private.is_member(buyer_group)
    or private.is_member(seller_group)
    or (select private.is_admin())
  );

create policy order_batches_select on public.order_batches for select to authenticated
  using (private.is_member(group_id) or (select private.is_admin()));

create policy pnl_snapshots_select on public.pnl_snapshots for select to authenticated
  using (private.is_member(group_id) or (select private.is_admin()));

create policy lobby_results_select on public.lobby_results for select to anon, authenticated
  using (exists (select 1 from public.lobbies l where l.id = lobby_id));
