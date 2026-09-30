"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { ApiDataSource } from "./api/apiDataSource";
import { MockDataSource } from "./mock/mockDataSource";
import { ResourceStore } from "./resourceStore";
import type { InfrastructureDataSource } from "./source";

interface DataContextValue {
  source: InfrastructureDataSource;
  store: ResourceStore;
}

const DataContext = createContext<DataContextValue | null>(null);

/**
 * Chooses the data source for the whole app.
 *   NEXT_PUBLIC_INFRA_DATA_SOURCE=live → ApiDataSource (read-only control-plane API; no credentials in the browser)
 *   anything else (default)            → MockDataSource (Phase 1 prototype data)
 * The variable only selects a mode; it contains no secret.
 */
function createDataSource(): InfrastructureDataSource {
  return process.env.NEXT_PUBLIC_INFRA_DATA_SOURCE === "live" ? new ApiDataSource() : new MockDataSource();
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [value] = useState<DataContextValue>(() => {
    const source = createDataSource();
    return { source, store: new ResourceStore(source) };
  });
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useDataContext(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useDataContext must be used inside <DataProvider>");
  return ctx;
}
