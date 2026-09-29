"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { MockDataSource } from "./mock/mockDataSource";
import { ResourceStore } from "./resourceStore";
import type { InfrastructureDataSource } from "./source";

interface DataContextValue {
  source: InfrastructureDataSource;
  store: ResourceStore;
}

const DataContext = createContext<DataContextValue | null>(null);

/**
 * Chooses the data source for the whole app. Phase 1 always uses the mock
 * source. The backend phase replaces `createDataSource` with an API-backed
 * implementation of `InfrastructureDataSource`.
 */
function createDataSource(): InfrastructureDataSource {
  return new MockDataSource();
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
