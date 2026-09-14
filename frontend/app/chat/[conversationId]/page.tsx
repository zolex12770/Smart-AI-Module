"use client";

import { use, useEffect, useState } from "react";
import { getConversationMessages, type Message } from "../../lib/api";
import ChatView from "../ChatView";

/**
 * A client component, like every other screen in this app — docs/26_DECISIONS.md ADR-115.
 *
 * This was the last server component in the repository, and it could not work as one. The render
 * called `getConversationMessages` → `request` → `apiFetch`, which lives in a `"use client"`
 * module: React refuses to call a client export from the server, so the route was a hard error
 * rather than a degraded screen. Even without that, the call could not have succeeded — `apiFetch`
 * sends `credentials: "include"` and reads the selected project from `localStorage`, and the Next
 * server holds neither the browser's session cookie nor its storage, so the API would have
 * answered 401.
 *
 * It broke the two things a user does most: every conversation in the sidebar, and the redirect
 * that lands here right after the first message of a NEW chat — so a first-time user watched their
 * answer stream and then landed on an error page. `/agent/[id]` and `/coding/[id]` had the same
 * defect and were converted; this one was missed, which is why the fix is written out here rather
 * than left as a one-line pragma.
 */
export default function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = use(params);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setError(null);
    getConversationMessages(conversationId)
      .then((r) => {
        if (!cancelled) setMessages(r.messages);
      })
      .catch((err: unknown) => {
        // A conversation that is gone, or a session that expired, is a message — not a blank page.
        if (!cancelled) setError(err instanceof Error ? err.message : "This conversation could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (error) {
    // A conversation that is gone, or a session that expired, is a message — not a blank page.
    return (
      <p className="page-state" role="alert">
        {error} <a href="/chat">Start a new conversation</a>
      </p>
    );
  }

  // ChatView seeds its transcript from `initialMessages` on mount, so it is rendered only once the
  // history is here; handing it an empty array first would leave the conversation permanently blank.
  if (!messages) return <p className="page-state">Loading conversation…</p>;

  return <ChatView key={conversationId} conversationId={conversationId} initialMessages={messages} />;
}
