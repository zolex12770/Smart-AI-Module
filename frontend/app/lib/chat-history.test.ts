import { describe, expect, it } from "vitest";
import { historyForRequest } from "./chat-history";

/** ADR-110: an error placeholder is shown to the person, never sent back as a turn. */
describe("historyForRequest", () => {
  it("drops a failed turn's error text, which the server never stored", () => {
    expect(
      historyForRequest([
        { role: "user", content: "first" },
        { role: "assistant", content: "Token quota exceeded.", isError: true },
        { role: "user", content: "second" },
      ])
    ).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);
  });

  it("keeps real replies, and sends only the role and the content", () => {
    expect(historyForRequest([{ role: "assistant", content: "hello", isError: false }])).toEqual([
      { role: "assistant", content: "hello" },
    ]);
  });
});
