import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { JoinButton } from "@/components/group/join-button";
import { getViewer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export default function JoinPage({ params }: PageProps<"/join/[token]">) {
  return (
    <div className="mx-auto mt-16 max-w-md">
      <div className="panel p-6">
        <Suspense fallback={<p className="text-sm text-muted">Checking invite…</p>}>
          <Join params={params} />
        </Suspense>
      </div>
    </div>
  );
}

async function Join({ params }: Pick<PageProps<"/join/[token]">, "params">) {
  const { token } = await params;
  const viewer = await getViewer();
  if (!viewer) redirect(`/login?next=/join/${token}`);

  const supabase = await createClient();
  const { data } = await supabase.rpc("peek_invite", { p_token: token });
  const group = data?.[0];

  if (!group) {
    return (
      <>
        <h1 className="text-lg font-semibold">Invite link not valid</h1>
        <p className="mt-2 text-sm text-muted">
          It may have been rotated. Ask an admin for a fresh link.
        </p>
      </>
    );
  }
  if (viewer.group?.slug === group.slug) redirect(`/g/${group.slug}`);
  if (viewer.group) {
    return (
      <>
        <h1 className="text-lg font-semibold">You are already in a group</h1>
        <p className="mt-2 text-sm text-muted">
          You belong to <Link href={`/g/${viewer.group.slug}`} className="text-accent">{viewer.group.name}</Link>.
          Ask an admin to move you to {group.name}.
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="text-lg font-semibold">Join {group.name}?</h1>
      <p className="mt-2 text-sm text-muted">
        You can only be in one group. Members can see and run each other&apos;s code.
      </p>
      <div className="mt-6">
        <JoinButton token={token} />
      </div>
    </>
  );
}
