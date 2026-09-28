import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ACO Bot",
  description: "OpenSea automated checkout — monitoring & execution dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-ink text-slate-200 antialiased">{children}</body>
    </html>
  );
}
