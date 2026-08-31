"use client";

import { useRef, useState } from "react";
import { streamChat, type ChatMessage } from "./lib/chat-stream";

interface DisplayMessage extends ChatMessage {
  isError?: boolean;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const conversationIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;

    const nextMessages: DisplayMessage[] = [...messages, { role: "user", content: text }];
    setMessages([...nextMessages, { role: "assistant", content: "" }]);
    setInput("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const stream = streamChat(
        nextMessages.map(({ role, content }) => ({ role, content })),
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
      if (result.value) {
        conversationIdRef.current = result.value;
      }
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <div className="chat-page">
      <header className="chat-header">
        <h1>AI Agent Platform — Chat (Phase 1)</h1>
        <p>Running against the mock LLM provider. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY on the API to use a real model.</p>
      </header>

      <div className="messages">
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
        <button type="submit" disabled={isStreaming || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function replaceLast(messages: DisplayMessage[], next: DisplayMessage): DisplayMessage[] {
  return [...messages.slice(0, -1), next];
}
