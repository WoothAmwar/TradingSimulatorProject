"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function GroupTabs({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/g/${slug}`;
  const tabs = [
    { href: base, label: "Overview" },
    { href: `${base}/code`, label: "Code & backtest" },
    { href: `${base}/live`, label: "Live trading" },
  ];
  return (
    <nav className="flex gap-1">
      {tabs.map((tab) => {
        const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rounded-md px-3 py-1.5 text-sm ${active ? "bg-panel-2 text-foreground" : "text-muted hover:text-foreground"}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
