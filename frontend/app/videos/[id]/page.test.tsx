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
});
