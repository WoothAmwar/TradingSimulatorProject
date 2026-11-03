"use client";

import { useState, useTransition } from "react";
import { deleteSubmission } from "@/app/actions/group";

export function DeleteSubmissionButton({ id, title }: { id: string; title: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-ask">{error}</span>}
      <button
        className="btn btn-danger px-2 py-0.5 text-xs"
        disabled={pending}
        onClick={() =>
          confirm(`Delete "${title}"? This cannot be undone.`) &&
          start(async () => {
            const result = await deleteSubmission(id);
            setError(result.ok ? null : result.error);
          })
        }
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
    </span>
  );
}
