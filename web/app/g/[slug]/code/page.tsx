import { Suspense } from "react";
import type { DatasetOption, RoundOption } from "@/components/code/code-workspace";
import { CodeWorkspaceLoader } from "@/components/code/code-workspace-loader";
import { getGroupContext, getStaticRounds } from "@/lib/group";
import { isLanguage } from "@/lib/templates";

export default function CodePage({ params, searchParams }: PageProps<"/g/[slug]/code">) {
  return (
    <Suspense fallback={<div className="panel h-[70vh] animate-pulse" />}>
      <Code params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Code({ params, searchParams }: Pick<PageProps<"/g/[slug]/code">, "params" | "searchParams">) {
  const { slug } = await params;
  const { from, round } = await searchParams;
  const { group, supabase } = await getGroupContext(slug);

  const [{ data: datasetRows }, staticRounds, submission] = await Promise.all([
    supabase
      .from("datasets")
      .select("lobby_id, ticks, lobbies!inner(name, created_at, kind)")
      .eq("lobbies.kind", "live")
      .order("created_at", { ascending: false }),
    getStaticRounds(),
    typeof from === "string"
      ? supabase
          .from("submissions")
          .select("title, language, source, lobby_id")
          .eq("id", from)
          .eq("group_id", group.id)
          .maybeSingle()
          .then((r) => r.data)
      : Promise.resolve(null),
  ]);

  const datasets: DatasetOption[] = (datasetRows ?? []).flatMap((d) =>
    d.lobbies ? [{ lobbyId: d.lobby_id, name: d.lobbies.name, ticks: d.ticks }] : [],
  );
  const rounds: RoundOption[] = staticRounds.map((r) => ({
    id: r.id,
    name: r.name,
    preset: r.preset,
    status: r.status,
    ticks: r.config.dataset_ticks,
    preview: r.config.preview,
  }));
  const requested = submission ? submission.lobby_id : typeof round === "string" ? round : null;
  const initialRound = rounds.some((r) => r.id === requested) ? requested : null;
  const initial = submission
    ? {
        title: submission.title,
        language: isLanguage(submission.language) ? submission.language : "python",
        source: submission.source,
      }
    : null;

  return (
    <CodeWorkspaceLoader
      groupId={group.id}
      slug={slug}
      datasets={datasets}
      rounds={rounds}
      initialRound={initialRound}
      initial={initial}
    />
  );
}
