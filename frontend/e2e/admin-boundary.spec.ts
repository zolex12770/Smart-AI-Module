import { expect, test } from "@playwright/test";

/**
 * The real authorization boundary, from both sides — docs/26_DECISIONS.md ADR-144.
 *
 * ADR-136 added an Enable button for MCP tools and showed it to every user, while the endpoint
 * answers 404 to anyone who is not a system administrator (ADR-089 — a reconnect or an enable
 * re-registers tools for every tenant in the deployment, and confirming an endpoint exists is
 * itself a disclosure). Its component test passed, because a component test mocks the API, and
 * the refusal lives in the API.
 *
 * So this test mocks nothing. It signs in as an ordinary member and as the real bootstrapped
 * system administrator, and checks four things against the running backend:
 *
 *   1. the ordinary member is not offered the control
 *   2. the administrator is
 *   3. the ordinary member calling the route directly is refused
 *   4. the administrator calling it directly succeeds
 *
 * (1) and (2) alone would pass against a UI that lies in the safe direction; (3) and (4) alone
 * would pass against a UI that offers an action nobody can take. The pair is the boundary.
 */
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Bootstrapped by `backend` when the E2E server starts with an empty user table. */
const ADMIN_EMAIL = "e2e-admin@example.com";
const PASSWORD = "a-sufficiently-long-password";

async function signUp(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Name").fill("E2E Member");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/chat");
}

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/chat");
}

/** Calls the API from inside the page, so it carries the browser's real session cookie. */
async function statusOfEnableCall(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(async () => {
    const api = (window as unknown as { __API_URL__?: string }).__API_URL__ ?? "http://127.0.0.1:8790";
    const csrf = document.cookie
      .split("; ")
      .find((c) => c.startsWith("aip_csrf="))
      ?.slice("aip_csrf=".length);
    const res = await fetch(`${api}/api/v1/tools/mcp.reference-filesystem.read_text_file/enable`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify({ enabled: true }),
    });
    return res.status;
  });
}

test.describe("system-admin boundary", () => {
  test("an ordinary member is neither offered the control nor allowed to call it", async ({ page }) => {
    await signUp(page, `e2e-member-${unique()}@example.com`);

    await page.goto("/tasks");
    await page.getByLabel(/task type/i).selectOption("mcp_read_and_summarize");

    // The MCP section renders — knowing which tools exist is not privileged...
    await expect(page.getByText(/MCP tools are registered disabled on purpose/i)).toBeVisible({ timeout: 30_000 });
    // ...and it says whose decision enabling one is.
    await expect(page.getByText(/system administrator/i)).toBeVisible();
    // But the control is not there.
    await expect(page.getByRole("button", { name: /^enable$/i })).toHaveCount(0);

    // And the backend refuses this session directly. 404, not 403: ADR-089.
    expect(await statusOfEnableCall(page)).toBe(404);
  });

  test("the system administrator is offered the control and the backend accepts it", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);

    await page.goto("/tasks");
    await page.getByLabel(/task type/i).selectOption("mcp_read_and_summarize");

    // The control is offered...
    const enable = page.getByRole("button", { name: /^enable$/i }).first();
    await expect(enable).toBeVisible({ timeout: 30_000 });

    // ...and the same call the button makes really succeeds for this session.
    expect(await statusOfEnableCall(page)).toBe(200);

    // Pressing it changes the listed state, which is the point of the control existing.
    await page.reload();
    await page.getByLabel(/task type/i).selectOption("mcp_read_and_summarize");
    await expect(page.getByRole("button", { name: /^disable$/i }).first()).toBeVisible({ timeout: 30_000 });
  });

  test("the administrator's own reconnect control is offered, and hidden from a member", async ({ page }) => {
    // The second control behind the same guard — added because the route had no caller at all
    // (ADR-144), and because one guarded control proves a check, not a pattern.
    await signIn(page, ADMIN_EMAIL);
    await page.goto("/platform");
    await expect(page.getByRole("heading", { name: /MCP servers/i })).toBeVisible({ timeout: 30_000 });
    // Waited for rather than counted: the screen paints before the session resolves, so an
    // immediate count reads zero for everyone and would make this pass for the wrong reason.
    await expect(page.getByRole("button", { name: /^reconnect$/i }).first()).toBeVisible({ timeout: 30_000 });
    const adminSees = await page.getByRole("button", { name: /^reconnect$/i }).count();

    // The nav and the Settings card both offer Sign out; either ends the session.
    await page.goto("/settings");
    await page.getByRole("button", { name: /sign out/i }).first().click();
    await page.waitForURL(/\/login/);

    await signUp(page, `e2e-member2-${unique()}@example.com`);
    await page.goto("/platform");
    await expect(page.getByRole("heading", { name: /MCP servers/i })).toBeVisible({ timeout: 30_000 });
    // The member must SEE the same server the administrator saw before this concludes the
    // control is absent. Accepting "No MCP servers configured" as an alternative made this pass
    // against an ungated build, because an empty list has no buttons either — checked by
    // removing the guard and watching this test stay green.
    // The MCP list ITEM, not the text: the tools table lists 14 ids containing the same name.
    await expect(
      page.locator("li").filter({ hasText: /reference-filesystem/i }).first()
    ).toBeVisible({ timeout: 30_000 });
    const memberSees = await page.getByRole("button", { name: /^reconnect$/i }).count();

    // The administrator sees one per configured server; the member sees none. If no MCP server is
    // configured in this environment both are zero, which would make the comparison vacuous — so
    // the admin count is asserted to be non-zero rather than merely different.
    expect(adminSees).toBeGreaterThan(0);
    expect(memberSees).toBe(0);
  });
});
