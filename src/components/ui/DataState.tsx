import type { ReactNode } from "react";
import type { Resource } from "@/lib/data/hooks";
import { ErrorState, LoadingState } from "./States";

/**
 * Renders the loading / error / success states of a resource consistently.
 * Components receive fully-loaded, typed data via the render prop.
 */
export function DataState<T>({
  resource,
  loading,
  children,
}: {
  resource: Resource<T>;
  loading?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === "error") return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (resource.data === undefined) return <>{loading ?? <LoadingState />}</>;
  return <>{children(resource.data)}</>;
}
