"use client";

import { useEffect, useRef } from "react";

export type ConsoleLine = { text: string; kind: "log" | "info" | "error" };

export function ConsoleView({ lines, height = "16rem" }: { lines: ConsoleLine[]; height?: string }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [lines]);
  return (
    <div
      className="num overflow-y-auto rounded-md border border-border bg-background p-2 text-xs leading-relaxed"
      style={{ height }}
    >
      {lines.length === 0 && <span className="text-muted">Console output appears here.</span>}
      {lines.map((line, i) => (
        <pre
          key={i}
          className={`whitespace-pre-wrap ${line.kind === "error" ? "text-ask" : line.kind === "info" ? "text-accent" : "text-foreground/90"}`}
        >
          {line.text}
        </pre>
      ))}
      <div ref={end} />
    </div>
  );
}

export function appendLines(prev: ConsoleLine[], lines: string[], kind: ConsoleLine["kind"] = "log") {
  if (!lines.length) return prev;
  const next = [...prev, ...lines.map((text) => ({ text, kind }))];
  return next.length > 800 ? next.slice(-800) : next;
}
