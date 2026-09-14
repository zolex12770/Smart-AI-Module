import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import VideosPage from "./page";

/**
 * What the Videos screen is allowed to claim — docs/26_DECISIONS.md ADR-124.
 *
 * The page stated in fixed prose that clips came from "a mock clip provider" and that each scene
 * was "a real, playable animated GIF". That was written when the mock was the only option; once a
 * real local provider existed the sentence was simply false, and no endpoint exposed enough for
 * the page to say anything else. Both directions of that mistake matter: presenting a placeholder
 * as a result, and hiding a real capability behind a stale disclaimer.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/videos",
}));

const listVideos = vi.fn(async () => ({ projects: [] }));
const getProviders = vi.fn();
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  listVideos: () => listVideos(),
  createVideo: vi.fn(),
  getProviders: () => getProviders(),
}));

describe("Videos screen provider disclosure", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("says plainly that output is a placeholder when the provider is a mock", async () => {
    getProviders.mockResolvedValue({ providers: { video: { available: true, name: "mock", isMock: true } } });

    render(<VideosPage />);

    // Exact, because "mock" appears twice on purpose: once as the provider's NAME and once in
    // the sentence explaining what that means. A loose matcher here would be ambiguous.
    await waitFor(() => expect(screen.getByText("mock")).toBeInTheDocument());
    expect(screen.getByText(/placeholder animation, not a generated video/i)).toBeInTheDocument();
  });

  it("names a real provider and repeats its own statement of its ceiling", async () => {
    getProviders.mockResolvedValue({
      providers: {
        video: {
          available: true,
          name: "image-motion",
          isMock: false,
          technique: "a generated still, animated by ffmpeg — motion, not a video model",
        },
      },
    });

    render(<VideosPage />);

    await waitFor(() => expect(screen.getByText("image-motion")).toBeInTheDocument());
    expect(screen.getByText(/motion, not a video model/i)).toBeInTheDocument();
    // The stale blanket disclaimer is gone: a real provider is not described as a mock.
    expect(screen.queryByText(/placeholder animation, not a generated video/i)).not.toBeInTheDocument();
  });

  it("claims nothing at all when the provider cannot be determined", async () => {
    getProviders.mockRejectedValue(new Error("offline"));

    render(<VideosPage />);

    await waitFor(() => expect(listVideos).toHaveBeenCalled());
    expect(screen.queryByText(/placeholder animation/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Clips come from/i)).not.toBeInTheDocument();
  });
});
