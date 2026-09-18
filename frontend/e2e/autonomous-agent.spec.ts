import { expect, test } from "@playwright/test";

/**
 * Starting the autonomous agent from the interface — docs/26_DECISIONS.md ADR-136.
 *
 * The task type list omitted `autonomous`, so the model-driven engine — the thing ADR-064 built
 * the whole unification for — could only be reached by posting JSON by hand. Every option on the
 * screen was a hardcoded recipe, which meant that to anyone using the product, the product was a
 * workflow runner.
 *
 * This drives it the way a person does: pick the type, describe an outcome, press the button, and
 * see the run appear with a real task id. The E2E backend answers from the mock provider (its
 * runtime probe points at a closed port), so the assertion is that the JOURNEY works — the option
 * exists, the request reaches the API, a task is created and its detail screen opens — not what a
 * particular model decides to do.
 */
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function signUp(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Name").fill("E2E Agent User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-sufficiently-long-password");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/chat");
}

test.describe("autonomous agent", () => {
  test("can be started from the Tasks screen and opens its own detail page", async ({ page }) => {
    const failures: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") failures.push(m.text());
    });

    await signUp(page, `e2e-agent-${unique()}@example.com`);
    await page.goto("/tasks");

    // The option is really there.
    const select = page.getByLabel(/task type/i);
    await expect(select).toBeVisible();
    await select.selectOption("autonomous");
    await expect(page.getByText(/the model plans, calls tools/i)).toBeVisible();

    await page.getByPlaceholder("goal").fill("Summarise what is in the workspace");
    await page.getByRole("button", { name: /start task/i }).click();

    // Creating a task navigates straight to its own detail screen.
    await page.waitForURL(/\/agent\/[0-9a-f-]{36}/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: /autonomous/i })).toBeVisible();

    // It renders the request it was actually given, rather than an empty shell.
    await expect(page.getByText(/Summarise what is in the workspace/)).toBeVisible({ timeout: 60_000 });

    // And the run is listed back on the Tasks screen, where it can be found again.
    await page.goto("/tasks");
    const row = page.locator("a.card-row").first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText("autonomous");

    expect(failures.filter((f) => /CORS|Access-Control|blocked/i.test(f))).toEqual([]);
  });
});
