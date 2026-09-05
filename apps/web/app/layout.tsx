import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "./lib/session-context";
import { AppChrome } from "./lib/app-chrome";

export const metadata: Metadata = {
  title: "AI Agent Platform",
  description: "Chat, agent tasks, coding agent, image/video generation, RAG, and memory",
};

/**
 * The session provider wraps the whole app so every screen shares one source of truth for
 * who is signed in and which project is selected (ADR-049), and so an unauthenticated visit
 * to any private screen redirects to /login from one place rather than per page.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <AppChrome>{children}</AppChrome>
        </SessionProvider>
      </body>
    </html>
  );
}
