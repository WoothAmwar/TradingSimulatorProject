import { Suspense } from "react";
import { GroupTabs } from "@/components/group/group-tabs";
import { getGroupContext } from "@/lib/group";

export default function GroupLayout({ children, params }: LayoutProps<"/g/[slug]">) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<div className="h-16" />}>
        <GroupHeader params={params} />
      </Suspense>
      {children}
    </div>
  );
}

async function GroupHeader({ params }: Pick<LayoutProps<"/g/[slug]">, "params">) {
  const { slug } = await params;
  const { group, isMember } = await getGroupContext(slug);
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Group</p>
        <h1 className="text-2xl font-semibold">{group.name}</h1>
        {!isMember && <p className="text-xs text-accent">Viewing as admin</p>}
      </div>
      <GroupTabs slug={slug} />
    </div>
  );
}
