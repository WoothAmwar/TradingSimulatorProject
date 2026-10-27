import { Suspense } from "react";
import type { DatasetOption } from "@/components/code/code-workspace";
import { CodeWorkspaceLoader } from "@/components/code/code-workspace-loader";
import { getGroupContext } from "@/lib/group";
import type { Language } from "@/lib/templates";

export default function CodePage({ params, searchParams }: PageProps<"/g/[slug]/code">) {
  return (
    <Suspense fallback={<div className="panel h-[70vh] animate-pulse" />}>
      <Code params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Code({ params, searchParams }: Pick<PageProps<"/g/[slug]/code">, "params" | "searchParams">) {
  const { slug } = await params;
  const { from } = await searchParams;
  const { group, supabase } = await getGroupContext(slug);

  const [{ data: datasetRows }, submission] = await Promise.all([
    supabase
      .from("datasets")
      .select("lobby_id, ticks, lobbies(name, created_at)")
      .order("created_at", { ascending: false }),
    typeof from === "string"
      ? supabase
          .from("submissions")
          .select("title, language, source")
          .eq("id", from)
          .eq("group_id", group.id)
          .maybeSingle()
          .then((r) => r.data)
      : Promise.resolve(null),
  ]);

  const datasets: DatasetOption[] = (datasetRows ?? []).flatMap((d) =>
    d.lobbies ? [{ lobbyId: d.lobby_id, name: d.lobbies.name, ticks: d.ticks }] : [],
  );
  const initial = submission
    ? { title: submission.title, language: submission.language as Language, source: submission.source }
    : null;

  return <CodeWorkspaceLoader groupId={group.id} slug={slug} datasets={datasets} initial={initial} />;
}
