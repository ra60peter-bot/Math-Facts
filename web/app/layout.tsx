import type { Metadata } from "next";
import { ThemeToggle } from "../components/theme-toggle";
import "./globals.css";
import "./redesign.css";

export const metadata: Metadata = {
  title: "Auto Math Facts",
  description: "Voice practice for addition, subtraction, and multiplication.",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{document.documentElement.dataset.theme=localStorage.getItem('math-facts-theme')==='light'?'light':'dark'}catch{}` }} />
      </head>
      <body><ThemeToggle />{children}</body>
    </html>
  );
}
