import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Agent Platform",
  description: "Chat, agent tasks, coding agent, image/video generation, RAG, and memory",
};

const NAV_LINKS = [
  { href: "/chat", label: "Chat" },
  { href: "/tasks", label: "Tasks" },
  { href: "/images", label: "Images" },
  { href: "/videos", label: "Videos" },
  { href: "/files", label: "Files" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <nav className="app-nav">
            <span className="app-nav-brand">AI Agent Platform</span>
            <div className="app-nav-links">
              {NAV_LINKS.map((link) => (
                <Link key={link.href} href={link.href} className="app-nav-link">
                  {link.label}
                </Link>
              ))}
            </div>
          </nav>
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
