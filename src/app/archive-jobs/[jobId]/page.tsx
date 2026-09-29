import type { Metadata } from "next";
import { ArchiveJobDetailView } from "@/components/views/ArchiveJobDetailView";

export async function generateMetadata({ params }: PageProps<"/archive-jobs/[jobId]">): Promise<Metadata> {
  const { jobId } = await params;
  return { title: jobId };
}

export default async function Page({ params }: PageProps<"/archive-jobs/[jobId]">) {
  const { jobId } = await params;
  return <ArchiveJobDetailView key={jobId} jobId={jobId} />;
}
