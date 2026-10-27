"use client";

import dynamic from "next/dynamic";

// The workspace uses Monaco, Web Workers and localStorage drafts: render it only in the browser.
export const CodeWorkspaceLoader = dynamic(
  () => import("./code-workspace").then((m) => m.CodeWorkspace),
  { ssr: false, loading: () => <div className="panel h-[70vh] animate-pulse" /> },
);
