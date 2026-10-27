import Link from "next/link";
import { Suspense } from "react";
import { ActiveSubmissionPicker } from "@/components/group/active-submission-picker";
import { getGroupContext, getGroupLobbies } from "@/lib/group";
import { STATUS_STYLES } from "@/lib/lobby";
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
  const { group, supabase } = await getGroupContext(slug);
  const [{ data: roster }, { data: submissions }, lobbies] = await Promise.all([
    supabase.rpc("get_group_roster", { p_group: group.id }),
    supabase
      .from("submissions")
      .select("id, title, language, author_id, created_at, source_sha256")
      .eq("group_id", group.id)
      .order("created_at", { ascending: false }),
    getGroupLobbies(group.id),
  ]);
  const names = new Map((roster ?? []).map((m) => [m.user_id, m.display_name]));
  const options = (submissions ?? []).map((s) => ({
    id: s.id,
    label: `${s.title} · ${languageLabel(s.language)} · ${names.get(s.author_id ?? "") ?? "unknown"}`,
  }));

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <section className="panel p-4">
          <h2 className="font-semibold">Lobbies</h2>
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
            One active submission per lobby. Any member can change it, and any member can run it from
            Live trading.
          </p>
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
                  <td className="text-muted">{languageLabel(s.language)}</td>
                  <td className="text-muted">{names.get(s.author_id ?? "") ?? "former member"}</td>
                  <td className="num text-xs text-muted">{s.source_sha256?.slice(0, 8)}</td>
                  <td className="num text-right text-xs text-muted">
                    {new Date(s.created_at).toLocaleString()}
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
