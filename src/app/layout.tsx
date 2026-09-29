import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { DataProvider } from "@/lib/data/DataProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "UniqBotz Infrastructure", template: "%s · UniqBotz Infrastructure" },
  description: "Internal control plane for UniqBotz data retention and archival (Phase 1 UI prototype, mock data).",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#0d1218" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DataProvider>
          <AppShell>{children}</AppShell>
        </DataProvider>
      </body>
    </html>
  );
}
