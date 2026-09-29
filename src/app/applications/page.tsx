import type { Metadata } from "next";
import { ApplicationsView } from "@/components/views/ApplicationsView";

export const metadata: Metadata = { title: "Applications" };

export default function Page() {
  return <ApplicationsView />;
}
