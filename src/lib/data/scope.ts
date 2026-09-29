"use client";

import { useSyncExternalStore } from "react";
import type { ApplicationId } from "@/lib/domain/types";

/** Global application scope chosen in the ApplicationSwitcher ("all" or an app id). */
export type AppScope = "all" | ApplicationId;

const STORAGE_KEY = "uniqbotz-infra:scope";
const listeners = new Set<() => void>();
let current: AppScope | null = null;

function read(): AppScope {
  if (current !== null) return current;
  try {
    current = window.localStorage.getItem(STORAGE_KEY) ?? "all";
  } catch {
    current = "all";
  }
  return current;
}

export function setAppScope(scope: AppScope) {
  current = scope;
  try {
    window.localStorage.setItem(STORAGE_KEY, scope);
  } catch {
    /* storage unavailable — scope still applies for this session */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAppScope(): AppScope {
  return useSyncExternalStore(subscribe, read, () => "all");
}

/** The scope as an optional application filter for data hooks. */
export function useScopedAppId(): ApplicationId | undefined {
  const scope = useAppScope();
  return scope === "all" ? undefined : scope;
}
