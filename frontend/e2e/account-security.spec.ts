import { expect, test } from "@playwright/test";

/**
 * Account security in a real browser — docs/26_DECISIONS.md ADR-127.
 *
 * `revokeAllSessions` shipped with a docstring naming a password change that no route, and no
 * screen, implemented. A user who believed their password was known could do nothing but delete
 * the account. This drives the journey end to end, because the part that matters most is the
 * part only a browser exercises: after the change the cookie the browser is still holding has to
 * stop working, and the new password has to be the one that gets back in.
 */
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const PASSWORD = "a-sufficiently-long-password";
const NEW_PASSWORD = "an-even-longer-new-password";

async function signUp(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Name").fill("E2E Security User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/chat");
}

test.describe("account security", () => {
  test("a user can see their sessions and change their password, which signs them out", async ({ page }) => {
    const email = `e2e-security-${unique()}@example.com`;
    await signUp(page, email);

    await page.goto("/settings");

    // The session list is real: the browser's own session is in it.
    await expect(page.getByText("Signed-in sessions")).toBeVisible();
    await expect(page.getByRole("button", { name: /end session/i }).first()).toBeVisible({ timeout: 30_000 });

    // A wrong current password is refused, and says nothing about which half was wrong.
    await page.getByLabel(/current password/i).fill("not-the-current-password");
    await page.getByLabel(/new password/i).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /change password/i }).click();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible({ timeout: 30_000 });

    // The real one works, and the browser is signed out — the whole point of the feature.
    await page.getByLabel(/current password/i).fill(PASSWORD);
    await page.getByLabel(/new password/i).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /change password/i }).click();
    await page.waitForURL(/\/login/, { timeout: 30_000 });

    // The old password no longer works...
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible({ timeout: 30_000 });

    // ...and the new one does.
    await page.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("**/chat", { timeout: 30_000 });
  });

  test("a user can delete their own account, and cannot sign in afterwards", async ({ page }) => {
    /**
     * NFR-008 / ADR-102 built this route to be driven by a person and then gave it no caller:
     * `grep -rn "auth/account" frontend` returned nothing at all. A privacy requirement that can
     * only be met by hand-writing an HTTP request is not met, so the check is that a browser can
     * do it — and that the account is really gone afterwards, not merely reported gone.
     */
    const email = `e2e-delete-${unique()}@example.com`;
    await signUp(page, email);
    await page.goto("/settings");

    await page.getByRole("button", { name: /delete account…/i }).click();

    // The typed confirmation is required: the button stays disabled until it matches exactly.
    const submit = page.getByRole("button", { name: /^delete my account$/i });
    await page.getByLabel(/current password/i).last().fill(PASSWORD);
    await expect(submit).toBeDisabled();
    await page.getByLabel(/type delete my account to confirm/i).fill("DELETE MY ACCOUNT");
    await expect(submit).toBeEnabled();

    await submit.click();
    await expect(page.getByText(/account deleted/i)).toBeVisible({ timeout: 30_000 });
    // What went is reported as counts, not as a bare "done".
    await expect(page.getByText(/project\(s\).*organization\(s\)/i)).toBeVisible();

    await page.getByRole("button", { name: /sign out/i }).last().click();
    await page.waitForURL(/\/login/, { timeout: 30_000 });

    // The account is gone: the password that worked a moment ago does not.
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible({ timeout: 30_000 });
  });
});
