import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatView from "./ChatView";
import type { ChatStreamEvent } from "../lib/chat-stream";

/**
 * What a send does when it does NOT go well — docs/26_DECISIONS.md ADR-123.
 *
 * `handleSubmit` was a `try`/`finally` with no `catch`, and only errors the SERVER managed to
 * send arrived as an `error` event. Anything that threw out of the generator — a dropped
 * connection, a CORS refusal, an abort — left the empty assistant bubble the send had optimis-
 * tically added, so the screen showed a blank answer and no reason for it. The browser run that
 * found this is in the E2E suite; these pin the behaviour at the component.
 *
 * The stop control is the same defect from the other end: an `AbortController` was created on
 * every send and nothing could reach it, so a wrong or endless answer had to be waited out.
 */
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => replace(...args), push: vi.fn() }),
  usePathname: () => "/chat",
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  listConversations: async () => ({ conversations: [] }),
}));

const streamChat = vi.fn();
/**
 * The session, because the sidebar reloads when the project changes (ADR-154). Only the one
 * field this component reads is provided — a mock that answered everything would let a
 * component start depending on something this test never exercises.
 */
vi.mock("../lib/session-context", () => ({
  useSession: () => ({ projectId: "p1" }),
}));

vi.mock("../lib/chat-stream", () => ({
  streamChat: (...args: unknown[]) => streamChat(...args),
}));

/** A generator that yields the given events, then throws — the shape a real failure takes. */
async function* failingAfter(events: ChatStreamEvent[], error: unknown) {
  for (const event of events) yield event;
  throw error;
}

async function send(text: string) {
  const user = userEvent.setup();
  render(<ChatView />);
  await user.type(screen.getByPlaceholderText(/say something/i), text);
  await user.click(screen.getByRole("button", { name: /send/i }));
  return user;
}

describe("ChatView failure and stop", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the reason when the stream throws instead of a blank answer", async () => {
    streamChat.mockImplementation(() => failingAfter([], new TypeError("Failed to fetch")));

    await send("hello");

    await waitFor(() => {
      expect(screen.getByText(/could not be delivered/i)).toBeInTheDocument();
    });
    // The real cause is shown, not a generic shrug — a CORS refusal reads exactly like this.
    expect(screen.getByText(/Failed to fetch/)).toBeInTheDocument();
    // And it is marked as an error, not passed off as the model's answer.
    expect(screen.getByText(/could not be delivered/i).className).toContain("error");
  });

  it("keeps the text that did arrive before the failure", async () => {
    streamChat.mockImplementation(() =>
      failingAfter([{ type: "token", delta: "Half an ans" }], new Error("connection reset"))
    );

    await send("hello");

    await waitFor(() => {
      expect(screen.getByText(/Half an ans/)).toBeInTheDocument();
    });
    expect(screen.getByText(/connection reset/)).toBeInTheDocument();
  });


  it("keeps the text that arrived before an IN-BAND error, not only a transport one", async () => {
    /**
     * docs/26_DECISIONS.md ADR-159. The `error` branch replaced the bubble outright, discarding
     * every token streamed before the failure — while the transport-failure branch, asserted by
     * the test above, deliberately keeps them under a comment saying "what arrived before the
     * stop is a real answer as far as it goes". The two paths described opposite policies for
     * the same situation, and the one a provider dying mid-answer actually takes was the one
     * that erased what the user had already read.
     */
    streamChat.mockImplementation(() =>
      (async function* () {
        yield { type: "token", delta: "Half an ans" } as ChatStreamEvent;
        yield {
          type: "error",
          message: "The model provider failed partway through responding.",
        } as ChatStreamEvent;
      })()
    );

    await send("hello");

    await waitFor(() => {
      expect(screen.getByText(/failed partway through/i)).toBeInTheDocument();
    });
    // Both, in one bubble: the answer as far as it went, and why it stopped.
    expect(screen.getByText(/Half an ans/)).toBeInTheDocument();
  });

  it("offers a stop control while streaming that aborts the request", async () => {
    let capturedSignal: AbortSignal | undefined;
    // A stream that never finishes on its own: only an abort ends it.
    streamChat.mockImplementation((_messages: unknown, _id: unknown, signal: AbortSignal) => {
      capturedSignal = signal;
      return (async function* () {
        yield { type: "token", delta: "thinking" } as ChatStreamEvent;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      })();
    });

    const user = await send("hello");

    const stop = await screen.findByRole("button", { name: /stop/i });
    expect(screen.queryByRole("button", { name: /send/i })).not.toBeInTheDocument();

    await user.click(stop);

    await waitFor(() => {
      expect(capturedSignal?.aborted).toBe(true);
    });
    // A stop is not an error: the partial answer stays, and the composer comes back.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
    });
    expect(screen.getByText("thinking")).toBeInTheDocument();
    expect(screen.getByText("thinking").className).not.toContain("error");
  });

  it("says so when a stop lands before any text arrived", async () => {
    streamChat.mockImplementation((_messages: unknown, _id: unknown, signal: AbortSignal) =>
      (async function* () {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
        yield { type: "token", delta: "never" } as ChatStreamEvent;
      })()
    );

    const user = await send("hello");
    await user.click(await screen.findByRole("button", { name: /stop/i }));

    await waitFor(() => {
      expect(screen.getByText(/stopped before the model answered/i)).toBeInTheDocument();
    });
  });

  it("does not navigate to a conversation that was never created", async () => {
    streamChat.mockImplementation(() => failingAfter([], new TypeError("Failed to fetch")));

    await send("hello");

    await waitFor(() => {
      expect(screen.getByText(/could not be delivered/i)).toBeInTheDocument();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("says what happened when the model asks for a tool, instead of stopping silently", async () => {
    /**
     * Chat has no executor — docs/26_DECISIONS.md ADR-141.
     *
     * The route streams `tool_call` events and stores them, and nothing anywhere runs one, so a
     * model that reached for a tool produced a turn that simply stopped with no explanation. The
     * fix is not to execute tools here: the reasoning loop already does that with approval
     * gating, budgets and an audit trail (ADR-064/133/139), and a weaker second copy inside a
     * chat route is the duplication ADR-064 removed. So chat says what happened and where the
     * capability is.
     */
    streamChat.mockImplementation(() =>
      (async function* () {
        yield { type: "token", delta: "Let me look that up. " } as ChatStreamEvent;
        yield { type: "tool_call", call: { id: "c1", name: "fs.read_file", arguments: { path: "notes.txt" } } } as ChatStreamEvent;
      })()
    );

    await send("what is in notes.txt?");

    await waitFor(() => {
      expect(screen.getByText(/asked to use the tool/i)).toBeInTheDocument();
    });
    // It names the tool, says chat does not run tools, and points at the thing that does.
    expect(screen.getByText(/fs\.read_file/)).toBeInTheDocument();
    expect(screen.getByText(/does not run tools/i)).toBeInTheDocument();
    expect(screen.getByText(/Autonomous agent task/i)).toBeInTheDocument();
    // The text that had already streamed is kept.
    expect(screen.getByText(/Let me look that up/)).toBeInTheDocument();
  });
});
