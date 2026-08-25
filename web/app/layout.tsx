import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Math Facts",
  description: "Voice-first addition and multiplication practice.",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
