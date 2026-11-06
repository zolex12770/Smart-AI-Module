"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { streamChat, type ChatMessage } from "../lib/chat-stream";
import {
  deleteConversation,
  listConversations,
  listModels,
  renameConversation,
  type Conversation,
  type Message,
  type ModelInfo,
} from "../lib/api";
import { historyForRequest } from "../lib/chat-history";
import { useSession } from "../lib/session-context";

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
  const { projectId } = useSession();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  /**
   * The sidebar's own failure, shown — ADR-154.
   *
   * The catch was `() => {}`, so a sidebar that could not load looked exactly like an account
   * with no conversations. It is kept apart from the composer's `error` so a listing failure
   * does not read as a failure to send.
   */
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  /** Rename/delete of the open conversation (audit finding 18): a draft title while editing. */
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>(toDisplay(initialMessages));
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  /**
   * Which model answers, as the API reports it. The header used to say "mock by default", which
   * stopped being true when mocks became opt-in and was false on every real deployment.
   * `undefined` while loading or if it could not be read; `null` when no model is configured.
   */
  const [chatModel, setChatModel] = useState<ModelInfo | null | undefined>(undefined);
  const conversationIdRef = useRef<string | undefined>(conversationId);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // `projectId` is in the dependency list because the sidebar is project-scoped server-side
    // and the switcher is on every screen (ADR-154): without it, switching project left the
    // previous project's conversations listed, and opening one 404'd.
    listConversations()
      .then((r) => {
        setConversations(r.conversations);
        setSidebarError(null);
      })
      .catch((e: unknown) => setSidebarError(e instanceof Error ? e.message : String(e)));
  }, [conversationId, projectId]);

  useEffect(() => {
    listModels()
      .then((r) => setChatModel(r.models.find((m) => m.isDefault) ?? null))
      // Not knowing which model answers is not a reason to block chat; the header just stays quiet.
      .catch(() => setChatModel(undefined));
  }, [projectId]);

  async function sendPrompt(customText?: string) {
    const text = (customText ?? input).trim();
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
        } else if (event.type === "done" && event.finishReason === "length") {
          // Audit finding 24: an answer cut off at the output cap looked complete. It is marked
          // as cut off, in the words a reader can act on.
          setMessages((prev) =>
            replaceLast(prev, {
              role: "assistant",
              content: `${assistantText}\n\n[This answer was cut off at the output limit. Ask the model to continue, or for a shorter answer.]`,
            })
          );
        } else if (event.type === "tool_call") {
          /**
           * A tool call in CHAT is reported, not run — docs/26_DECISIONS.md ADR-141.
           *
           * This event was dropped silently. Chat has no executor: the route streams tool calls
           * and stores them, and nothing anywhere runs one, so a model that decided to reach for
           * a tool produced a turn that simply stopped — with the reason invisible.
           *
           * It is not fixed by executing tools here. The reasoning loop already does that, with
           * approval gating, budgets, an audit trail and self-correction (ADR-064/133/139), and a
           * second weaker copy inside a chat route is exactly the duplication that ADR-064
           * removed. So chat says what happened and where the capability lives.
           */
          setMessages((prev) =>
            replaceLast(prev, {
              role: "assistant",
              content:
                `${assistantText}${assistantText ? "\n\n" : ""}` +
                `The model asked to use the tool "${event.call.name}". Chat does not run tools — ` +
                `start an Autonomous agent task from the Tasks screen for work that needs them.`,
              isError: true,
            })
          );
        } else if (event.type === "error") {
          /**
           * The text that already arrived is kept — docs/26_DECISIONS.md ADR-159.
           *
           * This replaced the bubble outright, discarding every token streamed before the
           * failure — while the transport-failure branch below deliberately keeps them, with a
           * comment saying "what arrived before the stop is a real answer as far as it goes".
           * The two paths described opposite policies for the same situation, and the one a
           * provider dying mid-answer actually takes was the one that erased what the user had
           * read. The server stores the partial turn with the same marker (ADR-151), so the
           * transcript and the screen agree.
           */
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            const partial = last?.role === "assistant" ? last.content : "";
            return replaceLast(prev, {
              role: "assistant",
              content: partial ? `${partial}\n\n${event.message}` : event.message,
              isError: true,
            });
          });
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await sendPrompt();
  }

  const current = conversations.find((c) => c.id === conversationId);

  async function saveTitle(e: React.FormEvent) {
    e.preventDefault();
    if (!conversationId || titleDraft === null || !titleDraft.trim()) return;
    setManageError(null);
    try {
      const { title } = await renameConversation(conversationId, titleDraft.trim());
      setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, title } : c)));
      setTitleDraft(null);
    } catch (err) {
      setManageError(`Could not rename: ${describe(err)}`);
    }
  }

  async function removeConversation() {
    if (!conversationId) return;
    if (!window.confirm("Delete this conversation? Its messages will no longer be shown anywhere.")) return;
    setManageError(null);
    try {
      await deleteConversation(conversationId);
      router.replace("/chat");
    } catch (err) {
      setManageError(`Could not delete: ${describe(err)}`);
    }
  }

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <Link href="/chat" className="btn btn-secondary" style={{ display: "block", textAlign: "center", marginBottom: 10 }}>
          + New chat
        </Link>
        {sidebarError && <p className="error-text">{sidebarError}</p>}
        {conversations.length === 0 && !sidebarError && <p className="empty-state">No conversations yet.</p>}
        {conversations.map((c) => (
          <Link
            key={c.id}
            href={`/chat/${c.id}`}
            className={`chat-sidebar-item ${c.id === conversationId ? "active" : ""}`}
          >
            {c.title ?? "Untitled conversation"}
          </Link>
        ))}
      </aside>

      <div className="chat-page">
        <header className="chat-header">
          <h1>{current?.title ?? "Chat"}</h1>
          {conversationId ? (
            titleDraft === null ? (
              <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setTitleDraft(current?.title ?? "")}>
                  Rename
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => void removeConversation()}>
                  Delete
                </button>
              </div>
            ) : (
              <form onSubmit={saveTitle} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                <input
                  aria-label="Conversation title"
                  value={titleDraft}
                  maxLength={200}
                  onChange={(e) => setTitleDraft(e.target.value)}
                />
                <button type="submit" className="btn" disabled={!titleDraft.trim()}>
                  Save
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setTitleDraft(null)}>
                  Cancel
                </button>
              </form>
            )
          ) : null}
          {manageError ? (
            <p className="error-text" role="alert">
              {manageError}
            </p>
          ) : null}
          {chatModel && !chatModel.isMock && !chatModel.isLocal ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0" }}>
              <span
                style={{
                  background: "#059669",
                  color: "#ffffff",
                  fontSize: "11px",
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: "4px",
                  letterSpacing: "0.05em",
                }}
              >
                REAL MODEL
              </span>
              <span style={{ fontSize: "13px", color: "var(--muted)" }}>
                Connected to genuine hosted provider: <strong>{chatModel.provider}</strong> ({chatModel.model})
              </span>
            </div>
          ) : chatModel && !chatModel.isMock && chatModel.isLocal ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0" }}>
              <span
                style={{
                  background: "#2563eb",
                  color: "#ffffff",
                  fontSize: "11px",
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: "4px",
                  letterSpacing: "0.05em",
                }}
              >
                LOCAL MODEL
              </span>
              <span style={{ fontSize: "13px", color: "var(--muted)" }}>
                Connected to local runtime: <strong>{chatModel.model}</strong> ({chatModel.provider})
              </span>
            </div>
          ) : chatModel && chatModel.isMock ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0" }}>
              <span
                style={{
                  background: "#d97706",
                  color: "#ffffff",
                  fontSize: "11px",
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: "4px",
                  letterSpacing: "0.05em",
                }}
              >
                MOCK / SIMULATION
              </span>
              <span style={{ fontSize: "13px", color: "var(--muted)" }}>
                Simulation mode only: replies are canned mock text for testing, not a real AI model.
              </span>
            </div>
          ) : chatModel === null ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                margin: "8px 0",
                padding: "8px 12px",
                borderRadius: "6px",
                background: "color-mix(in srgb, #dc2626 10%, transparent)",
                border: "1px solid #dc2626",
              }}
              role="alert"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    background: "#dc2626",
                    color: "#ffffff",
                    fontSize: "11px",
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: "4px",
                    letterSpacing: "0.05em",
                  }}
                >
                  PROVIDER UNAVAILABLE
                </span>
                <span style={{ fontSize: "13px", fontWeight: 600, color: "#dc2626" }}>
                  No language model is configured on this deployment.
                </span>
              </div>
              <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--fg)" }}>
                To chat with a real AI, configure an API key (e.g. <code>GEMINI_API_KEY</code>, <code>OPENAI_API_KEY</code>, or <code>ANTHROPIC_API_KEY</code>) in <code>backend/.env</code> or start a local Ollama / OpenAI-compatible runtime on <code>127.0.0.1:11434</code>.
              </p>
            </div>
          ) : null}
        </header>

        <div className="messages">
          {messages.length === 0 && (
            <div style={{ textAlign: "center", padding: "32px 16px" }}>
              <p className="empty-state" style={{ marginBottom: 16 }}>
                Welcome to NirnayAI Chat. Ask a question or click a prompt to start:
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 600, margin: "0 auto" }}>
                {[
                  "👋 Hello",
                  "🧮 What is 2 + 2?",
                  "💻 return 'hello world' in c++",
                  "🐍 Write a Python function to reverse a string",
                  "🇮🇳 Explain recursion in simple Hindi",
                ].map((promptText) => (
                  <button
                    key={promptText}
                    type="button"
                    onClick={() => void sendPrompt(promptText)}
                    disabled={isStreaming}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      padding: "8px 14px",
                      borderRadius: "20px",
                      fontSize: "13px",
                      cursor: "pointer",
                      color: "var(--fg)",
                    }}
                  >
                    {promptText}
                  </button>
                ))}
              </div>
            </div>
          )}
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
            placeholder={chatModel === null ? "No language model configured (see instructions above)" : "Say something…"}
            disabled={isStreaming || chatModel === null}
          />
          {isStreaming ? (
            // The AbortController existed and nothing could reach it, so a long or wrong answer
            // had to be waited out. Aborting releases the reader, which stops the server
            // streaming into a page nobody is reading — and stops the billing with it.
            <button type="button" className="btn-secondary" onClick={() => controllerRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() || chatModel === null}>
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
