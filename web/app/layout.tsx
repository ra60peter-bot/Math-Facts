import type { Metadata } from "next";
import { ThemeToggle } from "../components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Math Facts",
  description: "Voice-first addition and multiplication practice.",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{document.documentElement.dataset.theme=localStorage.getItem('math-facts-theme')==='dark'?'dark':'light'}catch{}` }} />
      </head>
      <body><ThemeToggle />{children}</body>
    </html>
  );
}
