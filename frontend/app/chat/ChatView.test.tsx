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
});
