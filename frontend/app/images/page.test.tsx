import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ImagesPage from "./page";

/**
 * What the Images screen is allowed to claim.
 *
 * It said, in fixed prose, that every image was "a real, clearly-labeled placeholder SVG" from a
 * mock — false whenever a real provider (stable-diffusion.cpp, an OpenAI-compatible server) was
 * configured, and false by default once mocks became opt-in. The screen now repeats what the API
 * reports, and refuses to offer a Generate button for a capability that is not there.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/images",
}));

const listImages = vi.fn(async () => ({ generations: [] as unknown[] }));
const getProviders = vi.fn();
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  listImages: () => listImages(),
  createImage: vi.fn(),
  getProviders: () => getProviders(),
}));

describe("Images screen provider disclosure", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("names a real provider and does not call it a mock", async () => {
    getProviders.mockResolvedValue({ providers: { image: { available: true, name: "stable-diffusion.cpp", isMock: false } } });
    render(<ImagesPage />);
    await waitFor(() => expect(screen.getByText("stable-diffusion.cpp")).toBeInTheDocument());
    expect(screen.queryByText(/placeholder/i)).toBeNull();
  });

  it("says plainly that output is a placeholder when the provider is a mock", async () => {
    getProviders.mockResolvedValue({ providers: { image: { available: true, name: "mock", isMock: true } } });
    render(<ImagesPage />);
    await waitFor(() => expect(screen.getByText(/labelled placeholder, not a generated image/i)).toBeInTheDocument());
  });

  it("says generation is not configured, and disables Generate, when there is no provider", async () => {
    getProviders.mockResolvedValue({ providers: { image: { available: false } } });
    render(<ImagesPage />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/not configured on this deployment/i));
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("offers a download for a finished image", async () => {
    getProviders.mockResolvedValue({ providers: { image: { available: true, name: "stable-diffusion.cpp", isMock: false } } });
    listImages.mockResolvedValue({
      generations: [{ id: "g1", prompt: "a red apple", status: "succeeded", resultAssetId: "asset-1", errorMessage: null }],
    });
    render(<ImagesPage />);
    const link = (await screen.findByRole("link", { name: "Download" })) as HTMLAnchorElement;
    expect(link.href).toContain("/api/v1/assets/asset-1");
  });
});
