"use client";

import { Info } from "lucide-react";
import { combineResources, useApplicationNames, useArchiveCandidates } from "@/lib/data/hooks";
import { useScopedAppId } from "@/lib/data/scope";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, LoadingState } from "@/components/ui/States";
import { ArchiveCandidateCard } from "@/components/archive/ArchiveCandidateCard";
import { ScopeEyebrow } from "./ScopeEyebrow";

export function ArchiveCandidatesView() {
  const appId = useScopedAppId();
  const names = useApplicationNames();
  const all = combineResources({ candidates: useArchiveCandidates(appId) });
  return (
    <>
      <PageHeader
        eyebrow={<ScopeEyebrow />}
        title="Archive Candidates"
        description="Preview of data that WOULD be eligible for archival under each enabled Archive policy. Nothing on this page is frozen, exported or deleted."
      />
      <div className="mb-5 flex items-start gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-ink-2">
        <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
        <p>
          <strong className="text-ink">Day-wise cumulative selection.</strong> Start at the oldest eligible date, add each{" "}
          <em>complete</em> day across every selected table, and stop on the first day that reaches or crosses the target. The final
          day is never split, so the selected count is usually slightly above the target. The last completed date becomes the next
          archive boundary.
        </p>
      </div>
      <DataState resource={all} loading={<LoadingState rows={10} />}>
        {({ candidates }) =>
          candidates.length === 0 ? (
            <Card>
              <EmptyState title="No archive candidates" description="No enabled Archive policy has eligible data in the current scope." />
            </Card>
          ) : (
            <div className="space-y-6">
              {[...candidates]
                .sort((a, b) => b.tables.length - a.tables.length)
                .map((c) => (
                  <ArchiveCandidateCard key={c.id} candidate={c} appName={names[c.applicationId] ?? c.applicationId} />
                ))}
            </div>
          )
        }
      </DataState>
    </>
  );
}
