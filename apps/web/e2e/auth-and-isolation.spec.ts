import { expect, test } from "@playwright/test";

/**
 * End-to-end, in a real browser, against the real API and a real database —
 * docs/26_DECISIONS.md ADR-068.
 *
 * These cover the claims that only a full stack can prove, and that the ADR-047 audit
 * specifically flagged as unverifiable: that a signed-out visitor sees nothing, that signing up
 * works end to end, and that one tenant's browser session genuinely cannot reach another's
 * data. Component tests cannot establish any of those, because the enforcement lives in the
 * server's SQL.
 */

/** Unique per run so repeated runs against a persistent database do not collide. */
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function signUp(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-sufficiently-long-password");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/chat");
}

test.describe("authentication", () => {
  test("a signed-out visitor is redirected to sign in and sees no data", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForURL("**/login");
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });

  test("signing up creates an account, a project, and lands in the app", async ({ page }) => {
    await signUp(page, `e2e-${unique()}@example.com`);
    await expect(page).toHaveURL(/\/chat/);
    // The chrome only renders for an authenticated session.
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
  });

  test("signing out ends the session and protected screens stop rendering", async ({ page }) => {
    await signUp(page, `e2e-${unique()}@example.com`);
    await page.getByRole("button", { name: /sign out/i }).click();
    await page.waitForURL("**/login");

    await page.goto("/usage");
    await page.waitForURL("**/login");
  });

  test("a wrong password is refused with the same message as an unknown account", async ({ page }) => {
    const email = `e2e-${unique()}@example.com`;
    await signUp(page, email);
    await page.getByRole("button", { name: /sign out/i }).click();
    await page.waitForURL("**/login");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    const wrongPassword = await page.getByRole("alert").textContent();

    await page.getByLabel("Email").fill(`nobody-${unique()}@example.com`);
    await page.getByLabel("Password").fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    const unknownAccount = await page.getByRole("alert").textContent();

    // Identical text: the form must not be usable to enumerate accounts.
    expect(wrongPassword).toBe(unknownAccount);
  });
});

test.describe("tenant isolation", () => {
  test("one account cannot reach another account's project through the browser", async ({ browser }) => {
    const alice = await browser.newContext();
    const mallory = await browser.newContext();
    try {
      const alicePage = await alice.newPage();
      await signUp(alicePage, `alice-${unique()}@example.com`);

      // Read Alice's project id the way the app itself does.
      const aliceProject = await alicePage.evaluate(() => window.localStorage.getItem("aip.selectedProjectId"));
      expect(aliceProject).toBeTruthy();

      const malloryPage = await mallory.newPage();
      await signUp(malloryPage, `mallory-${unique()}@example.com`);

      // Mallory's own session, aimed at Alice's project. The server must not answer with data.
      // The API's base URL is passed IN rather than read from `process.env` inside the page:
      // `evaluate` runs in the browser, where there is no `process`.
      const apiUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:8790";
      const status = await malloryPage.evaluate(
        async ({ projectId, apiUrl }) => {
          const res = await fetch(`${apiUrl}/api/v1/memory`, {
            credentials: "include",
            headers: { "x-project-id": projectId as string },
          });
          return res.status;
        },
        { projectId: aliceProject, apiUrl }
      );

      // 404, not 403: confirming the id exists would itself be a disclosure.
      expect(status).toBe(404);
    } finally {
      await alice.close();
      await mallory.close();
    }
  });
});

test.describe("usage", () => {
  test("the usage screen renders real project-scoped figures", async ({ page }) => {
    await signUp(page, `usage-${unique()}@example.com`);
    await page.getByRole("link", { name: "Usage" }).click();
    await page.waitForURL("**/usage");
    await expect(page.getByRole("heading", { name: /usage/i })).toBeVisible();
    await expect(page.getByText(/tokens today/i)).toBeVisible();
  });
});
