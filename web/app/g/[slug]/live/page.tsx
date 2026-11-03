import { Suspense } from "react";
import { LivePanel, type LiveLobby } from "@/components/live/live-panel";
import { ENGINE_URL } from "@/lib/engine";
import { getGroupContext, getGroupLobbies } from "@/lib/group";

export default function LivePage({ params }: PageProps<"/g/[slug]/live">) {
  return (
    <Suspense fallback={<div className="panel h-96 animate-pulse" />}>
      <Live params={params} />
    </Suspense>
  );
}

async function Live({ params }: Pick<PageProps<"/g/[slug]/live">, "params">) {
  const { slug } = await params;
  const { group, supabase } = await getGroupContext(slug);
  const lobbies = (await getGroupLobbies(group.id)).filter((l) =>
    ["scheduled", "running", "paused"].includes(l.status),
  );
  const activeIds = lobbies.flatMap((l) => (l.activeSubmissionId ? [l.activeSubmissionId] : []));
  const { data: submissions } = activeIds.length
    ? await supabase.from("submissions").select("id, title, language").in("id", activeIds)
    : { data: [] };

  const live: LiveLobby[] = lobbies.map((l) => {
    const s = submissions?.find((x) => x.id === l.activeSubmissionId);
    return {
      id: l.id,
      name: l.name,
      status: l.status,
      active: s ? { id: s.id, title: s.title, language: s.language } : null,
    };
  });

  // Admins outside the group may watch its bot too; the engine checks.
  return <LivePanel slug={slug} engineUrl={ENGINE_URL} groupId={group.id} lobbies={live} />;
}
