import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CodeEditor } from "@/components/code/code-editor";
import { getGroupContext } from "@/lib/group";
import { languageLabel } from "@/lib/templates";

export default function SubmissionPage({ params }: PageProps<"/g/[slug]/s/[id]">) {
  return (
    <Suspense fallback={<div className="panel h-96 animate-pulse" />}>
      <Submission params={params} />
    </Suspense>
  );
}

async function Submission({ params }: Pick<PageProps<"/g/[slug]/s/[id]">, "params">) {
  const { slug, id } = await params;
  const { group, supabase } = await getGroupContext(slug);
  const [{ data: submission }, { data: roster }] = await Promise.all([
    supabase.from("submissions").select("*").eq("id", id).eq("group_id", group.id).maybeSingle(),
    supabase.rpc("get_group_roster", { p_group: group.id }),
  ]);
  if (!submission) notFound();
  const author = roster?.find((m) => m.user_id === submission.author_id)?.display_name;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{submission.title}</h2>
          <p className="text-sm text-muted">
            {languageLabel(submission.language)} · {author ?? "former member"} ·{" "}
            {new Date(submission.created_at).toLocaleString()} ·{" "}
            <span className="num">sha256 {submission.source_sha256?.slice(0, 12)}</span>
          </p>
        </div>
        <Link href={`/g/${slug}/code?from=${submission.id}`} className="btn btn-primary">
          Open in editor
        </Link>
      </div>
      <CodeEditor language={submission.language} value={submission.source} readOnly height="70vh" />
    </div>
  );
}
