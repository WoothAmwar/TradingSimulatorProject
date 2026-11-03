"use client";

import { useState, useTransition } from "react";
import { setActiveSubmission } from "@/app/actions/group";
import { formatLocalTime, useHydrated } from "@/components/local-time";

export function ActiveSubmissionPicker({
  lobbyId,
  activeId,
  options,
}: {
  lobbyId: string;
  activeId: string | null;
  options: { id: string; title: string; createdAt: string; detail: string }[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const hydrated = useHydrated();
  // The save time tells versions with the same title apart; it comes early so it isn't cut off.
  const label = (o: (typeof options)[number]) =>
    [o.title, hydrated ? formatLocalTime(o.createdAt) : null, o.detail].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-2">
      <select
        className="input max-w-80"
        value={activeId ?? ""}
        disabled={pending || options.length === 0}
        onChange={(e) =>
          start(async () => {
            const result = await setActiveSubmission(lobbyId, e.target.value);
            setError(result.ok ? null : result.error);
          })
        }
      >
        <option value="" disabled>
          {options.length ? "Choose active submission…" : "Save a submission first"}
        </option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {label(o)}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-ask">{error}</span>}
    </div>
  );
}
