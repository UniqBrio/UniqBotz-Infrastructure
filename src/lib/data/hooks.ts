"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ApplicationId } from "@/lib/domain/types";
import { useDataContext } from "./DataProvider";
import type { ResourceEntry } from "./resourceStore";
import type { InfrastructureDataSource } from "./source";

export interface Resource<T> extends ResourceEntry<T> {
  reload: () => void;
}

const LOADING: ResourceEntry<never> = { status: "loading", data: undefined, error: undefined, refreshing: false };

export function useResource<T>(key: string, loader: (source: InfrastructureDataSource) => Promise<T>): Resource<T> {
  const { store } = useDataContext();
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  const entry = useSyncExternalStore(
    store.subscribe,
    () => store.get(key),
    () => undefined,
  ) as ResourceEntry<T> | undefined;

  useEffect(() => {
    store.ensure(key, (s) => loaderRef.current(s));
  }, [store, key]);

  const reload = useCallback(() => store.refetch(key), [store, key]);
  return { ...(entry ?? LOADING), reload };
}

const scopeKey = (appId?: ApplicationId) => appId ?? "*";

export const useApplications = () => useResource("applications", (s) => s.listApplications());
export const useApplicationHealthList = () => useResource("app-health", (s) => s.listApplicationHealth());
export const useApplicationHealth = (id: ApplicationId) =>
  useResource(`app-health:${id}`, (s) => s.getApplicationHealth(id));
export const useTables = (appId?: ApplicationId) => useResource(`tables:${scopeKey(appId)}`, (s) => s.listTables(appId));
export const useRetentionPolicies = (appId?: ApplicationId) =>
  useResource(`policies:${scopeKey(appId)}`, (s) => s.listRetentionPolicies(appId));
export const useArchiveCandidates = (appId?: ApplicationId) =>
  useResource(`candidates:${scopeKey(appId)}`, (s) => s.listArchiveCandidates(appId));
export const useArchiveJobs = (appId?: ApplicationId) =>
  useResource(`jobs:${scopeKey(appId)}`, (s) => s.listArchiveJobs(appId));
export const useArchiveJob = (id: string) => useResource(`job:${id}`, (s) => s.getArchiveJob(id));
export const useAlerts = (appId?: ApplicationId) => useResource(`alerts:${scopeKey(appId)}`, (s) => s.listAlerts(appId));
export const useAuditLog = (appId?: ApplicationId) =>
  useResource(`audit:${scopeKey(appId)}`, (s) => s.listAuditLog(appId));
export const useSettings = () => useResource("settings", (s) => s.getSettings());

/** Access to write operations; call `invalidate()` after a successful write. */
export function useMutations() {
  const { source, store } = useDataContext();
  return { source, invalidate: () => store.invalidateAll() };
}

/** id → display name lookup for registered applications. */
export function useApplicationNames(): Record<string, string> {
  const apps = useApplications();
  const names: Record<string, string> = {};
  for (const a of apps.data ?? []) names[a.id] = a.name;
  return names;
}

type ResourceMap = Record<string, Resource<unknown>>;
type DataOf<M extends ResourceMap> = { [K in keyof M]: M[K] extends Resource<infer T> ? T : never };

/** Combine several resources into one: loading until all have data, error if any failed. */
export function combineResources<M extends ResourceMap>(map: M): Resource<DataOf<M>> {
  const entries = Object.entries(map);
  const failed = entries.find(([, r]) => r.status === "error");
  const reload = () => entries.forEach(([, r]) => r.reload());
  if (failed) return { status: "error", data: undefined, error: failed[1].error, refreshing: false, reload };
  if (entries.some(([, r]) => r.data === undefined)) {
    return { status: "loading", data: undefined, error: undefined, refreshing: false, reload };
  }
  const data = Object.fromEntries(entries.map(([k, r]) => [k, r.data])) as DataOf<M>;
  return { status: "success", data, error: undefined, refreshing: entries.some(([, r]) => r.refreshing), reload };
}
