"use client";

import { useApplicationNames } from "@/lib/data/hooks";
import { useAppScope } from "@/lib/data/scope";

/** Shows which application scope the current page is filtered to. */
export function ScopeEyebrow() {
  const scope = useAppScope();
  const names = useApplicationNames();
  return <>Scope · {scope === "all" ? "All applications" : names[scope] ?? scope}</>;
}
