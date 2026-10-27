"use client";

import { useState, useTransition } from "react";
import { joinGroup } from "@/app/actions/group";

export function JoinButton({ token }: { token: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn btn-primary w-full py-2"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await joinGroup(token);
            if (!result.ok) setError(result.error);
          })
        }
      >
        {pending ? "Joining…" : "Join group"}
      </button>
      {error && <p className="mt-2 text-sm text-ask">{error}</p>}
    </>
  );
}
