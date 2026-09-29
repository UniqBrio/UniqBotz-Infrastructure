import type { Metadata } from "next";
import { ArchiveCandidatesView } from "@/components/views/ArchiveCandidatesView";

export const metadata: Metadata = { title: "Archive Candidates" };

export default function Page() {
  return <ArchiveCandidatesView />;
}
