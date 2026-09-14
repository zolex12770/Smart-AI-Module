import { expect, test } from "@playwright/test";

/**
 * The chat journey, in a real browser — docs/26_DECISIONS.md ADR-123.
 *
 * The suite navigated to `/chat` and never sent a message, which is why two defects survived every
 * green run:
 *
 *  - The streamed response set `Access-Control-Allow-Origin` but not
 *    `Access-Control-Allow-Credentials`. The client sends the request with `credentials:
 *    "include"`, and the CORS rules then require that header, so a browser discarded every answer
 *    the server had already produced. Only a browser can catch this: `fetch` from Node, `curl` and
 *    `app.inject()` all ignore CORS entirely.
 *  - Opening a saved conversation was a hard server error, and the redirect after the FIRST
 *    message of a new chat lands on exactly that route (ADR-115).
 *
 * The backend under test answers from the mock provider (the E2E server points the runtime probe
 * at a closed port), so the assertions are about the transport and the screen, not about what a
 * model happens to say.
 */
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function signUp(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Name").fill("E2E Chat User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-sufficiently-long-password");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/chat");
}

test.describe("chat", () => {
  test("a message streams an answer into the page, and the conversation survives a reload", async ({ page }) => {
    const failures: string[] = [];
    page.on("console", (message) => {
      // A CORS refusal surfaces here and nowhere else — the request "succeeds" on the wire.
      if (message.type() === "error") failures.push(message.text());
    });

    await signUp(page, `e2e-chat-${unique()}@example.com`);

    await page.getByPlaceholder(/say something/i).fill("Say hello to the end-to-end test");
    await page.getByRole("button", { name: /send/i }).click();

    // WORD characters, not merely "not empty". The send optimistically adds an empty assistant
    // bubble that renders a "…" placeholder while in flight, so `not.toBeEmpty()` passes against
    // a transport that never delivers anything — which is exactly how the CORS defect survived.
    // "…" contains no word character, and a failure renders as `.message.error`, so neither the
    // placeholder nor an error can satisfy this.
    const assistant = page.locator(".message.assistant").last();
    await expect(assistant).toContainText(/\w/, { timeout: 60_000 });

    // The first message redirects to /chat/<id> — the route that used to be a hard error.
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 60_000 });
    const conversationUrl = page.url();
    const answer = (await assistant.textContent())?.trim() ?? "";
    expect(answer.length).toBeGreaterThan(0);
    // Nothing failed along the way: a delivery failure would have left an error bubble.
    await expect(page.locator(".message.error")).toHaveCount(0);

    // Reload the conversation: history comes back from the server, not from memory.
    await page.reload();
    await expect(page.locator(".message.user").last()).toContainText("Say hello to the end-to-end test", {
      timeout: 60_000,
    });
    await expect(page.locator(".message.assistant").last()).not.toBeEmpty({ timeout: 60_000 });

    // Reopening the same URL in a fresh navigation works too (the sidebar's links).
    await page.goto("/chat");
    await page.goto(conversationUrl);
    await expect(page.locator(".message.user").last()).toContainText("Say hello to the end-to-end test", {
      timeout: 60_000,
    });

    expect(failures.filter((f) => /CORS|Access-Control|blocked/i.test(f))).toEqual([]);
  });
});
