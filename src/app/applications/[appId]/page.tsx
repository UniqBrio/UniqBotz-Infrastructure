import type { Metadata } from "next";
import { ApplicationDetailView } from "@/components/views/ApplicationDetailView";

export const metadata: Metadata = { title: "Application" };

export default async function Page({ params, searchParams }: PageProps<"/applications/[appId]">) {
  const { appId } = await params;
  const { table } = await searchParams;
  return <ApplicationDetailView key={appId} appId={appId} initialTable={typeof table === "string" ? table : undefined} />;
}
