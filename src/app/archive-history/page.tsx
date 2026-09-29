import type { Metadata } from "next";
import { ArchiveHistoryView } from "@/components/views/ArchiveHistoryView";

export const metadata: Metadata = { title: "Archive History" };

export default function Page() {
  return <ArchiveHistoryView />;
}
