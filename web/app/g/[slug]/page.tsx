import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { ActiveSubmissionPicker } from "@/components/group/active-submission-picker";
import { DeleteSubmissionButton } from "@/components/group/delete-submission-button";
import { LocalTime } from "@/components/local-time";
import { getGroupContext, getGroupLobbies, getStaticRounds } from "@/lib/group";
import { STATIC_PRESETS, STATUS_STYLES, statusLabel } from "@/lib/lobby";
import { languageLabel } from "@/lib/templates";

export default function GroupOverviewPage({ params }: PageProps<"/g/[slug]">) {
  return (
    <Suspense fallback={<div className="panel h-64 animate-pulse" />}>
      <Overview params={params} />
    </Suspense>
  );
}

async function Overview({ params }: Pick<PageProps<"/g/[slug]">, "params">) {
  const { slug } = await params;
  const { viewer, group, supabase } = await getGroupContext(slug);
  const [{ data: roster }, { data: submissions }, lobbies, rounds, { data: attempts }] = await Promise.all([
    supabase.rpc("get_group_roster", { p_group: group.id }),
    supabase
      .from("submissions")
      .select("id, title, language, author_id, created_at, source_sha256, lobby_id")
      .eq("group_id", group.id)
      .order("created_at", { ascending: false }),
    getGroupLobbies(group.id),
    getStaticRounds(),
    supabase
      .from("round_attempts")
      .select("lobby_id, submission_id, created_at")
      .eq("group_id", group.id)
      .order("created_at", { ascending: false }),
  ]);
  const roundIds = [...lobbies.map((l) => l.id), ...rounds.map((r) => r.id)];
  const { data: results } = roundIds.length
    ? await supabase.from("lobby_results").select("lobby_id, group_id, final_pnl, rank").in("lobby_id", roundIds)
    : { data: [] };
  const names = new Map((roster ?? []).map((m) => [m.user_id, m.display_name]));
  const roundNames = new Map(rounds.map((r) => [r.id, r.name]));
  const options = (submissions ?? [])
    .filter((s) => s.lobby_id === null)
    .map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.created_at,
      detail: `${languageLabel(s.language)} · ${names.get(s.author_id ?? "") ?? "unknown"}`,
    }));
  const scoreFor = (lobbyId: string) => {
    const rows = (results ?? []).filter((r) => r.lobby_id === lobbyId);
    const own = rows.find((r) => r.group_id === group.id);
    return own ? { score: Number(own.final_pnl), rank: own.rank, of: rows.length } : null;
  };
  const attemptsFor = (lobbyId: string) => (attempts ?? []).filter((a) => a.lobby_id === lobbyId);
  // Code that is a lobby's active submission or produced a round score is the record of what
  // competed, so it is kept. Otherwise its author (or an admin) may delete it.
  const inUse = new Set([
    ...lobbies.flatMap((l) => (l.activeSubmissionId ? [l.activeSubmissionId] : [])),
    ...(attempts ?? []).flatMap((a) => (a.submission_id ? [a.submission_id] : [])),
  ]);
  const canDelete = (authorId: string | null) => authorId === viewer.id || viewer.profile.is_admin;
  const scoreTiles: {
    id: string;
    name: string;
    kind: "live" | "static";
    result: ReturnType<typeof scoreFor>;
    note: ReactNode;
    href?: string;
  }[] = [
    ...lobbies.map((l) => {
      const live = l.status === "running" || l.status === "paused";
      return {
        id: l.id,
        name: l.name,
        kind: "live" as const,
        result: scoreFor(l.id),
        note: live ? "Live now: see the leaderboard" : `Lobby ${l.status}`,
        href: live ? `/?lobby=${l.id}` : undefined,
      };
    }),
    ...rounds.map((r) => {
      const last = attemptsFor(r.id)[0];
      return {
        id: r.id,
        name: r.name,
        kind: "static" as const,
        result: scoreFor(r.id),
        note: last ? (
          <>
            Last submitted <LocalTime iso={last.created_at} />
          </>
        ) : (
          "Not submitted yet"
        ),
      };
    }),
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <section className="panel p-4">
          <h2 className="font-semibold">Scores</h2>
          {scoreTiles.length === 0 && <p className="mt-2 text-sm text-muted">No rounds yet.</p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {scoreTiles.map((t) => (
              <div key={t.id} className="rounded-md border border-border bg-panel-2 p-3">
                <div className="flex items-center justify-between gap-2 text-xs text-muted">
                  <span className="truncate font-medium text-foreground">{t.name}</span>
                  <span className="uppercase tracking-wide">{t.kind}</span>
                </div>
                {t.result ? (
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className={`num text-xl ${t.result.score >= 0 ? "text-bid" : "text-ask"}`}>
                      {Math.round(t.result.score).toLocaleString()}
                    </span>
                    <span className="num text-xs text-muted">
                      #{t.result.rank} of {t.result.of}
                    </span>
                  </div>
                ) : (
                  <div className="num mt-1 text-xl text-muted">—</div>
                )}
                <p className="mt-1 text-xs text-muted">
                  {t.href ? (
                    <Link href={t.href} className="underline">
                      {t.note}
                    </Link>
                  ) : (
                    t.note
                  )}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="panel p-4">
          <h2 className="font-semibold">Live rounds</h2>
          {lobbies.length === 0 && (
            <p className="mt-2 text-sm text-muted">An admin hasn&apos;t entered your group in a lobby yet.</p>
          )}
          <ul className="mt-3 divide-y divide-border">
            {lobbies.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-2">
                  <Link href={`/?lobby=${l.id}`} className="font-medium hover:text-accent">
                    {l.name}
                  </Link>
                  <span className={`badge ${STATUS_STYLES[l.status]}`}>{l.status}</span>
                </div>
                <ActiveSubmissionPicker
                  lobbyId={l.id}
                  activeId={l.activeSubmissionId}
                  options={options}
                />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            One active submission per lobby. The exchange runs it while the round is live; any member can
            change it, and the new one takes over within seconds.
          </p>
        </section>

        <section className="panel p-4">
          <h2 className="font-semibold">Static rounds</h2>
          {rounds.length === 0 && <p className="mt-2 text-sm text-muted">No static rounds are published yet.</p>}
          <ul className="mt-3 divide-y divide-border">
            {rounds.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <span className={`badge ${STATUS_STYLES[r.status]}`}>{statusLabel("static", r.status)}</span>
                  </div>
                  <p className="text-xs text-muted">
                    {STATIC_PRESETS[r.preset].name} · {attemptsFor(r.id).length} submission
                    {attemptsFor(r.id).length === 1 ? "" : "s"} scored
                  </p>
                </div>
                <Link href={`/g/${slug}/code?round=${r.id}`} className="btn">
                  Write code
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Each round has its own code. Your latest submission is your score.</p>
        </section>

        <section className="panel p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Submissions</h2>
            <Link href={`/g/${slug}/code`} className="btn btn-primary">
              New submission
            </Link>
          </div>
          {(submissions ?? []).length === 0 && (
            <p className="mt-3 text-sm text-muted">No code yet. Start from a template in the editor.</p>
          )}
          <table className="mt-3 w-full text-sm">
            <tbody className="divide-y divide-border">
              {(submissions ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="py-2">
                    <Link href={`/g/${slug}/s/${s.id}`} className="font-medium hover:text-accent">
                      {s.title}
                    </Link>
                  </td>
                  <td className="text-muted">
                    {s.lobby_id ? (roundNames.get(s.lobby_id) ?? "Static round") : "Live"}
                  </td>
                  <td className="text-muted">{languageLabel(s.language)}</td>
                  <td className="text-muted">{names.get(s.author_id ?? "") ?? "former member"}</td>
                  <td className="num text-xs text-muted">{s.source_sha256?.slice(0, 8)}</td>
                  <td className="num text-right text-xs text-muted">
                    <LocalTime iso={s.created_at} />
                  </td>
                  <td className="pl-3 text-right">
                    {inUse.has(s.id) ? (
                      <span className="text-xs text-muted" title="Active in a lobby or scored in a round, so it is kept">
                        in use
                      </span>
                    ) : (
                      canDelete(s.author_id) && <DeleteSubmissionButton id={s.id} title={s.title} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <aside className="panel h-fit p-4">
        <h2 className="font-semibold">Members</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {(roster ?? []).map((m) => (
            <li key={m.user_id} className="flex items-center gap-2">
              {m.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.avatar_url} alt="" className="h-6 w-6 rounded-full" />
              ) : (
                <span className="h-6 w-6 rounded-full bg-panel-2" />
              )}
              {m.display_name}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
