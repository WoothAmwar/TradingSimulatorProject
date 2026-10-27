import Link from "next/link";
import { getViewer } from "@/lib/auth";

export async function UserMenu() {
  const viewer = await getViewer();
  if (!viewer) {
    return (
      <Link href="/login" className="btn btn-primary">
        Sign in
      </Link>
    );
  }
  const { profile, group } = viewer;
  return (
    <div className="flex items-center gap-3 text-sm">
      {profile.is_admin && <span className="badge bg-accent/15 text-accent">admin</span>}
      {group && (
        <Link href={`/g/${group.slug}`} className="btn">
          {group.name}
        </Link>
      )}
      <span className="hidden text-muted sm:inline">{profile.display_name}</span>
      <form action="/auth/signout" method="post">
        <button className="btn" type="submit">
          Sign out
        </button>
      </form>
    </div>
  );
}
