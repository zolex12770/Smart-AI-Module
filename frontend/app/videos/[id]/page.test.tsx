import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The video screen's actions — audit findings 17 and 18. Retry and Cancel had no `catch`, so a
 * 429 or 501 was an unhandled rejection and nothing was shown; one failed poll replaced the whole
 * screen for good; and a cancelled project, which the backend resumes, offered no way to.
 */
const api = vi.hoisted(() => ({ getVideo: vi.fn(), retryVideo: vi.fn(), cancelVideo: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  ...api,
}));

import VideoDetailPage from "./page";

const project = (over: Record<string, unknown> = {}) => ({
  id: "v1",
  projectId: "p1",
  prompt: "A lighthouse at dusk",
  status: "failed",
  renderStatus: "pending",
  cancelRequestedAt: null,
  script: null,
  targetDurationSeconds: 12,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});
const scene = (status: string) => ({
  id: `s-${status}`,
  videoProjectId: "v1",
  sceneIndex: 0,
  shotDescription: "waves",
  durationSeconds: 4,
  status,
  jobId: null,
  assetId: null,
});

async function mount() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <VideoDetailPage params={Promise.resolve({ id: "v1" })} />
      </Suspense>
    );
  });
}

describe("video detail actions", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows why a retry was refused", async () => {
    api.getVideo.mockResolvedValue({ project: project(), scenes: [scene("failed")] });
    const { ApiError } = await import("../../lib/auth-client");
    api.retryVideo.mockRejectedValue(new ApiError(429, "QUOTA_EXCEEDED", "Monthly video-seconds limit reached."));
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: /retry failed scenes/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/monthly video-seconds limit reached/i);
  });

  it("offers to resume a cancelled project", async () => {
    api.getVideo.mockResolvedValue({ project: project({ status: "cancelled" }), scenes: [scene("cancelled")] });
    api.retryVideo.mockResolvedValue({ project: project({ status: "generating_scenes" }) });
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: /resume/i }));
    await vi.waitFor(() => expect(api.retryVideo).toHaveBeenCalledWith("v1"));
  });

  it("keeps the video on screen when one poll fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.getVideo
        .mockResolvedValueOnce({ project: project(), scenes: [scene("failed")] })
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValue({ project: project(), scenes: [scene("failed")] });
      await mount();
      expect(await screen.findByText("A lighthouse at dusk")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(screen.getByText("A lighthouse at dusk")).toBeTruthy();
      expect(screen.getByText(/could not refresh this video: network down/i)).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(screen.queryByText(/could not refresh this video/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers the WebM rendition after the MP4, so a browser without H.264 still plays the render", async () => {
    api.getVideo.mockResolvedValue({
      project: project({
        status: "succeeded",
        renderStatus: "succeeded",
        renderAssetId: "mp4-asset",
        renderWebmAssetId: "webm-asset",
        subtitleVttAssetId: "vtt-asset",
      }),
      scenes: [scene("succeeded")],
    });
    await mount();
    const container = document.body;
    await vi.waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const video = container.querySelector("video")!;
    // A `src` on the element would override every <source>, so the fallback would never be tried.
    expect(video.getAttribute("src")).toBeNull();
    const sources = [...video.querySelectorAll("source")].map((s) => [s.getAttribute("src"), s.getAttribute("type")]);
    expect(sources).toHaveLength(2);
    expect(sources[0]![0]).toContain("mp4-asset");
    expect(sources[0]![1]).toMatch(/^video\/mp4; codecs=/);
    expect(sources[1]![0]).toContain("webm-asset");
    expect(sources[1]![1]).toMatch(/^video\/webm; codecs=/);
    expect(video.querySelector("track")?.getAttribute("src")).toContain("vtt-asset");
  });

  it("offers only the MP4 when no WebM was produced", async () => {
    api.getVideo.mockResolvedValue({
      project: project({ status: "succeeded", renderStatus: "succeeded", renderAssetId: "mp4-asset", renderWebmAssetId: null }),
      scenes: [scene("succeeded")],
    });
    await mount();
    const container = document.body;
    await vi.waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    expect(container.querySelectorAll("video source")).toHaveLength(1);
  });
});
