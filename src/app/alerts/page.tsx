import type { Metadata } from "next";
import { AlertsView } from "@/components/views/AlertsView";

export const metadata: Metadata = { title: "Alerts" };

export default function Page() {
  return <AlertsView />;
}
