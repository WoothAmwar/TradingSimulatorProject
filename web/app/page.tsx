import Link from "next/link";
import { Suspense } from "react";
import { AdminPanel, type AdminData } from "@/components/admin/admin-panel";
import { LiveMarket } from "@/components/market/live-market";
import { Scoreboard, type ScoreboardData } from "@/components/market/scoreboard";
import { StaticRoundCard } from "@/components/market/static-round-card";
import { getViewer } from "@/lib/auth";
import { ENGINE_URL } from "@/lib/engine";
import { getStaticRounds } from "@/lib/group";
import { publicConfig, STATUS_STYLES } from "@/lib/lobby";
import { createClient } from "@/lib/supabase/server";

export default function HomePage({ searchParams }: PageProps<"/">) {
  return (
    <div className="space-y-10">
      <Suspense fallback={<div className="panel h-96 animate-pulse" />}>
        <Market searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={null}>
        <AdminSection />
      </Suspense>
    </div>
  );
}

async function Market({ searchParams }: Pick<PageProps<"/">, "searchParams">) {
  const { lobby: requested } = await searchParams;
  const supabase = await createClient();
  const [{ data }, rounds, { data: groups }, viewer] = await Promise.all([
    supabase
      .from("lobbies")
      .select("id, name, status, public_config")
      .eq("kind", "live")
      .neq("status", "draft")
      .order("created_at", { ascending: false }),
    getStaticRounds(),
    supabase.from("groups").select("id, name").order("name"),
    getViewer(),
  ]);
  const lobbies = data ?? [];
  const { data: results } = rounds.length
    ? await supabase
        .from("lobby_results")
        .select("lobby_id, group_id, final_pnl, rank")
        .in("lobby_id", rounds.map((r) => r.id))
    : { data: [] };
  const groupNames = new Map((groups ?? []).map((g) => [g.id, g.name]));
  const roundResults = (id: string) => (results ?? []).filter((r) => r.lobby_id === id);
  const scoreboard: ScoreboardData = {
    groups: groups ?? [],
    columns: rounds.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      scores: Object.fromEntries(
        roundResults(r.id).map((x) => [x.group_id, { score: Number(x.final_pnl), rank: x.rank }]),
      ),
    })),
  };

  if (lobbies.length === 0 && rounds.length === 0) {
    return (
      <div className="panel p-10 text-center">
        <h1 className="text-xl font-semibold">No market is open yet</h1>
        <p className="mt-2 text-sm text-muted">
          An admin needs to create and publish a lobby. Check back soon.
        </p>
      </div>
    );
  }

  const selected =
    lobbies.find((l) => l.id === requested) ??
    lobbies.find((l) => l.status === "running" || l.status === "paused") ??
    lobbies.find((l) => l.status === "scheduled") ??
    lobbies[0];

  return (
    <div className="space-y-10">
      {selected ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {lobbies.map((l) => (
              <Link
                key={l.id}
                href={`/?lobby=${l.id}`}
                className={`btn ${l.id === selected.id ? "border-accent" : ""}`}
              >
                {l.name}
                <span className={`badge ${STATUS_STYLES[l.status]}`}>{l.status}</span>
              </Link>
            ))}
          </div>
          <LiveMarket
            key={selected.id}
            lobbyId={selected.id}
            lobbyName={selected.name}
            engineUrl={ENGINE_URL}
            goods={publicConfig(selected.public_config).goods}
            scoreboard={scoreboard}
          />
        </section>
      ) : (
        <Scoreboard {...scoreboard} />
      )}

      {rounds.length > 0 && (
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Static rounds</h2>
            <p className="text-sm text-muted">
              The whole market is published up front. Write code for each round and submit it for a score.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {rounds.map((r) => (
              <StaticRoundCard
                key={r.id}
                round={r}
                leaders={roundResults(r.id)
                  .map((x) => ({ name: groupNames.get(x.group_id) ?? "?", score: Number(x.final_pnl), rank: x.rank }))
                  .sort((a, b) => a.rank - b.rank)}
                codeHref={viewer?.group ? `/g/${viewer.group.slug}/code?round=${r.id}` : null}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

async function AdminSection() {
  const viewer = await getViewer();
  if (!viewer?.profile.is_admin) return null;
  const supabase = await createClient();

  const [groups, invites, members, lobbies, secrets, entries, profiles, allowlist] =
    await Promise.all([
      supabase.from("groups").select("id, name, slug").order("created_at"),
      supabase.from("group_invites").select("group_id, token"),
      supabase.from("group_members").select("group_id, user_id, profiles(display_name, email)"),
      supabase
        .from("lobbies")
        .select("id, name, status, max_groups, public_config, current_tick, kind")
        .order("created_at", { ascending: false }),
      supabase.from("lobby_secrets").select("lobby_id, seed::text"),
      supabase.from("lobby_entries").select("lobby_id, group_id, active_submission_id"),
      supabase.from("profiles").select("id, display_name, email, is_admin").order("created_at"),
      supabase.from("admin_allowlist").select("email").order("email"),
    ]);

  const data: AdminData = {
    viewerId: viewer.id,
    groups: (groups.data ?? []).map((g) => ({
      ...g,
      token: invites.data?.find((i) => i.group_id === g.id)?.token ?? null,
      members: (members.data ?? [])
        .filter((m) => m.group_id === g.id)
        .map((m) => ({
          userId: m.user_id,
          name: m.profiles?.display_name ?? null,
          email: m.profiles?.email ?? null,
        })),
    })),
    lobbies: (lobbies.data ?? []).map((l) => ({
      ...l,
      config: publicConfig(l.public_config),
      seed: (secrets.data?.find((s) => s.lobby_id === l.id)?.seed as string | undefined) ?? null,
      groupIds: (entries.data ?? []).filter((e) => e.lobby_id === l.id).map((e) => e.group_id),
    })),
    profiles: profiles.data ?? [],
    allowlist: (allowlist.data ?? []).map((a) => a.email),
  };

  return <AdminPanel data={data} engineUrl={ENGINE_URL} />;
}
