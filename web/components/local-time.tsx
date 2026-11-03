"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * The server doesn't know the viewer's time zone, so times are formatted only in the browser:
 * this is false while rendering on the server and hydrating, and true afterwards.
 */
export function useHydrated() {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

export const formatLocalTime = (iso: string) => new Date(iso).toLocaleString();

/** A timestamp in the viewer's local time. */
export function LocalTime({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  return <time dateTime={iso}>{hydrated ? formatLocalTime(iso) : ""}</time>;
}
