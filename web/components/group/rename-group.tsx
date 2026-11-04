"use client";

import { useState, useTransition } from "react";
import { renameGroup } from "@/app/actions/group";

/** The group's name as the page heading, with a button to rename it in place. */
export function RenameGroup({ groupId, name }: { groupId: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold">{name}</h1>
        <button className="btn px-2 py-0.5 text-xs" onClick={() => setEditing(true)}>
          Rename
        </button>
      </div>
    );
  }

  const cancel = () => {
    setEditing(false);
    setError(null);
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      action={(form) =>
        start(async () => {
          const result = await renameGroup(groupId, String(form.get("name") ?? ""));
          if (result.ok) cancel();
          else setError(result.error);
        })
      }
    >
      <input
        name="name"
        className="input text-lg"
        defaultValue={name}
        aria-label="Group name"
        required
        maxLength={60}
        autoFocus
        onKeyDown={(e) => e.key === "Escape" && cancel()}
      />
      <button className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
      <button type="button" className="btn" disabled={pending} onClick={cancel}>
        Cancel
      </button>
      {error && <span className="text-xs text-ask">{error}</span>}
    </form>
  );
}
