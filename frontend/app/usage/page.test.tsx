import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/** Audit finding 22: embedding and speech limits were enforced and never shown; cost scope was mixed. */
vi.mock("../lib/auth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth-client")>()),
  apiFetch: async () => ({
    usage: {
      llm: { tokensToday: 10, tokensThisMonth: 20, estimatedCostUsdThisMonth: 0.75, pricedCallsOnly: true },
      images: { generatedToday: 0 },
      video: { secondsGeneratedThisMonth: 0 },
      embeddings: { tokensToday: 100, tokensThisMonth: 400 },
      speech: { charactersToday: 300, charactersThisMonth: 900 },
    },
    projectUsage: {
      llm: { tokensToday: 5, tokensThisMonth: 10, estimatedCostUsdThisMonth: 0.25, pricedCallsOnly: true },
      images: { generatedToday: 0 },
      video: { secondsGeneratedThisMonth: 0 },
      embeddings: { tokensThisMonth: 40 },
      speech: { charactersThisMonth: 0 },
    },
    limits: {
      dailyTokenLimit: null,
      monthlyTokenLimit: null,
      dailyImageLimit: null,
      monthlyVideoSecondsLimit: null,
      dailyEmbeddingTokenLimit: null,
      monthlyEmbeddingTokenLimit: 1000,
      dailySpeechCharacterLimit: 5000,
      monthlySpeechCharacterLimit: null,
    },
  }),
}));
vi.mock("../lib/session-context", () => ({
  useSession: () => ({ projectId: "p1" }),
  RequireSession: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import UsagePage from "./page";

describe("Usage page", () => {
  it("shows embedding and speech meters, and the organization and project cost apart", async () => {
    render(<UsagePage />);
    expect((await screen.findAllByText("Embedding tokens this month")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Speech characters today").length).toBe(1);
    expect(screen.getByText("$0.7500")).toBeTruthy();
    expect(screen.getByText(/This project: \$0\.2500/)).toBeTruthy();
  });
});
