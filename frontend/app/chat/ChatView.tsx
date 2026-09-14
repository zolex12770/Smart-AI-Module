"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { streamChat, type ChatMessage } from "../lib/chat-stream";
import { listConversations, type Conversation, type Message } from "../lib/api";
import { historyForRequest } from "../lib/chat-history";

interface DisplayMessage extends ChatMessage {
  isError?: boolean;
}

function toDisplay(messages: Message[]): DisplayMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export default function ChatView({
  conversationId,
  initialMessages = [],
}: {
  conversationId?: string;
  initialMessages?: Message[];
}) {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<DisplayMessage[]>(toDisplay(initialMessages));
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const conversationIdRef = useRef<string | undefined>(conversationId);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    listConversations()
      .then((r) => setConversations(r.conversations))
      .catch(() => {});
  }, [conversationId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;

    const nextMessages: DisplayMessage[] = [...messages, { role: "user", content: text }];
    setMessages([...nextMessages, { role: "assistant", content: "" }]);
    setInput("");
    setIsStreaming(true);

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const stream = streamChat(
        historyForRequest(nextMessages),
        conversationIdRef.current,
        controller.signal
      );

      let assistantText = "";
      let result = await stream.next();
      while (!result.done) {
        const event = result.value;
        if (event.type === "token") {
          assistantText += event.delta;
          setMessages((prev) => replaceLast(prev, { role: "assistant", content: assistantText }));
        } else if (event.type === "error") {
          setMessages((prev) => replaceLast(prev, { role: "assistant", content: event.message, isError: true }));
        }
        result = await stream.next();
      }
      const wasNewConversation = !conversationIdRef.current;
      if (result.value) conversationIdRef.current = result.value;
      if (wasNewConversation && result.value) {
        router.replace(`/chat/${result.value}`);
      }
    } catch (err) {
      // A transport failure threw straight out of the generator: the `error` event above only
      // covers errors the SERVER managed to send. A dropped connection, a CORS refusal or a
      // stop leaves an empty bubble and a screen that says nothing happened — the silent
      // failure of docs/26_DECISIONS.md ADR-123. Every exit from a send now says what became
      // of the answer.
      const stopped = controller.signal.aborted;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        const partial = last?.role === "assistant" ? last.content : "";
        if (stopped) {
          // What arrived before the stop is a real answer as far as it goes — keep it.
          return replaceLast(prev, {
            role: "assistant",
            content: partial || "Stopped before the model answered.",
          });
        }
        return replaceLast(prev, {
          role: "assistant",
          content: `${partial ? `${partial}\n\n` : ""}The answer could not be delivered: ${describe(err)}`,
          isError: true,
        });
      });
    } finally {
      controllerRef.current = null;
      setIsStreaming(false);
    }
  }

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <Link href="/chat" className="btn btn-secondary" style={{ display: "block", textAlign: "center", marginBottom: 10 }}>
          + New chat
        </Link>
        {conversations.length === 0 && <p className="empty-state">No conversations yet.</p>}
        {conversations.map((c) => (
          <Link
            key={c.id}
            href={`/chat/${c.id}`}
            className={`chat-sidebar-item ${c.id === conversationId ? "active" : ""}`}
          >
            {c.title ?? c.id.slice(0, 8)}
          </Link>
        ))}
      </aside>

      <div className="chat-page">
        <header className="chat-header">
          <h1>Chat</h1>
          <p>Running against whichever provider is configured (mock by default) — see README for real provider setup.</p>
        </header>

        <div className="messages">
          {messages.length === 0 && <p className="empty-state">Say something to start the conversation.</p>}
          {messages.map((m, i) => (
            <div key={i} className={`message ${m.isError ? "error" : m.role}`}>
              {m.content || (isStreaming && i === messages.length - 1 ? "…" : "")}
            </div>
          ))}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Say something…"
            disabled={isStreaming}
          />
          {isStreaming ? (
            // The AbortController existed and nothing could reach it, so a long or wrong answer
            // had to be waited out. Aborting releases the reader, which stops the server
            // streaming into a page nobody is reading — and stops the billing with it.
            <button type="button" className="btn-secondary" onClick={() => controllerRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()}>
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function describe(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "the connection to the server failed";
}

function replaceLast(messages: DisplayMessage[], next: DisplayMessage): DisplayMessage[] {
  return [...messages.slice(0, -1), next];
}
