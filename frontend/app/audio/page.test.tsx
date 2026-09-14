import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AudioPage from "./page";

/**
 * The Audio screen — docs/26_DECISIONS.md ADR-114.
 *
 * Speech had no interface at all, so these cover what "a user can generate audio" actually needs:
 * the request reaches the API with what was typed, a finished clip is offered as a real playable
 * asset with its MEASURED duration, work in flight can be cancelled, and a deployment with no
 * synthesiser shows the reason instead of failing silently.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/audio",
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const GENERATION = {
  id: "gen-1",
  text: "The quick brown fox.",
  status: "succeeded" as const,
  providerName: "piper",
  voiceName: "en_US-lessac-medium.onnx",
  durationSeconds: 2.4,
  resultAssetId: "asset-1",
  errorMessage: null,
  createdAt: new Date().toISOString(),
};

describe("Audio page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.setItem("ai-platform.projectId", "project-1");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("plays a finished clip, with the measured duration and the voice that produced it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ generations: [GENERATION] }))
    );

    render(<AudioPage />);

    expect(await screen.findByText("The quick brown fox.")).toBeInTheDocument();
    // A real player pointed at the asset route — not an icon, not a placeholder.
    const player = document.querySelector("audio");
    expect(player).toBeTruthy();
    expect(player?.getAttribute("src")).toContain("/api/v1/assets/asset-1");
    expect(screen.getByText(/en_US-lessac-medium\.onnx · 2\.4s · piper/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute("download");
  });

  it("sends the typed text and the chosen speed, then clears the box", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ generation: { ...GENERATION, status: "pending" } }, 202) : json({ generations: [] })
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<AudioPage />);
    await user.type(screen.getByLabelText(/text/i), "Hello there");
    await user.selectOptions(screen.getByLabelText(/speed/i), "1.5");
    await user.click(screen.getByRole("button", { name: /generate speech/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
      expect(post).toBeTruthy();
      expect(String(post?.[0])).toContain("/api/v1/audio");
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ text: "Hello there", speed: 1.5 });
    });
    await waitFor(() => expect(screen.getByLabelText(/text/i)).toHaveValue(""));
  });

  it("shows the reason when the deployment has no speech provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? json(
              {
                error: {
                  code: "CAPABILITY_UNAVAILABLE",
                  message: "Audio generation is not available on this deployment: no speech provider is configured.",
                  requestId: "r1",
                },
              },
              501
            )
          : json({ generations: [] })
      ) as unknown as typeof fetch
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<AudioPage />);
    await user.type(screen.getByLabelText(/text/i), "Speak please");
    await user.click(screen.getByRole("button", { name: /generate speech/i }));

    expect(await screen.findByText(/no speech provider is configured/i)).toBeInTheDocument();
  });

  it("offers cancellation while work is in flight, and asks the API to cancel it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ ok: true, alreadyRequested: false })
        : json({ generations: [{ ...GENERATION, status: "processing", resultAssetId: null, durationSeconds: null }] })
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<AudioPage />);
    await user.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
      expect(String(post?.[0])).toContain("/api/v1/audio/gen-1/cancel");
    });
  });
});
