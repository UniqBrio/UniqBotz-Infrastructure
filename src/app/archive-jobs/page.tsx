import type { Metadata } from "next";
import { ArchiveJobsView } from "@/components/views/ArchiveJobsView";

export const metadata: Metadata = { title: "Archive Jobs" };

export default function Page() {
  return <ArchiveJobsView />;
}
