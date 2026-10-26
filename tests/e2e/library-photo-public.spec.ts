import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { openPostgres } from "../../lib/db/postgres/client";
import { authAccounts, authSessions, authUsers, householdMembers, households, libraryPhotos, people, photos, recipes } from "../../lib/db/schema";
import { LIBRARY_PHOTO_RECIPE } from "./library-photo-fixture";
import { expect, test } from "./member-fixture";
import { e2eTarget } from "./target";

const origin = `http://127.0.0.1:${process.env.E2E_PORT ?? "3112"}`;
const recipePath = `/recipes/${LIBRARY_PHOTO_RECIPE}`;
const password = "Synthetic-second-household-password-123!";

test("an approved library photo is public, credited, served with public headers, and shown to other households without their uploads", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const second = { household: `library-second-${randomUUID()}`, user: randomUUID(), email: `library-second-${randomUUID()}@example.test` };
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  try {
    const [library] = await handle.db.select({ uid: libraryPhotos.uid }).from(libraryPhotos).innerJoin(recipes, eq(recipes.id, libraryPhotos.recipeId)).where(eq(recipes.slug, LIBRARY_PHOTO_RECIPE));
    expect(library, "the browser fixture approves one library photo").toBeDefined();
    const uid = library!.uid;

    // A signed-out visitor sees the cover, the inline credit and the public credits page.
    const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    contexts.push(visitor);
    const anon = await visitor.newPage();
    await anon.goto(recipePath);
    await expect(anon.locator(`img[src="/library-photos/${uid}/master"]`).first()).toBeAttached();
    await expect(anon.getByText("Photo:", { exact: false }).first()).toContainText("Synthetic library falafel");
    await expect(anon.getByRole("link", { name: "all credits" }).first()).toHaveAttribute("href", "/credits");
    expect(await anon.content()).not.toContain("/photos/");
    await anon.goto("/recipes");
    await expect(anon.locator(`img[src="/library-photos/${uid}/thumb"]`).first()).toBeAttached();
    await anon.goto("/credits");
    await expect(anon.getByRole("heading", { name: "Photo credits", exact: true })).toBeVisible();
    await expect(anon.getByText("Images were resized and converted to WebP")).toBeVisible();
    const credit = anon.getByRole("listitem").filter({ hasText: "Synthetic Author" });
    await expect(credit).toHaveCount(1);
    await expect(credit.getByRole("link", { name: "Synthetic library falafel" })).toHaveAttribute("href", "https://commons.example.test/synthetic-falafel");
    await expect(credit.getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute("href", "https://creativecommons.org/licenses/by-sa/4.0/");
    await expect(anon.getByRole("link", { name: "Review more photos" })).toHaveCount(0);

    // The library route is public: shared-cache headers, no cookie, and the security headers from next.config survive.
    for (const variant of ["master", "thumb"] as const) {
      const response = await visitor.request.get(`${origin}/library-photos/${uid}/${variant}`);
      expect(response.status()).toBe(200);
      const headers = response.headers();
      expect(headers["cache-control"]).toBe("public, max-age=86400");
      expect(headers["cdn-cache-control"]).toBe("public, max-age=2592000, stale-while-revalidate=86400");
      expect(headers["content-type"]).toBe("image/webp");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["referrer-policy"]).toBe("same-origin");
      expect(headers.etag).toMatch(/^"[0-9a-f]{64}(-thumb)?"$/);
      expect(headers["set-cookie"]).toBeUndefined();
      const meta = await sharp(await response.body()).metadata();
      expect(meta.format).toBe("webp");
      expect(Math.max(meta.width!, meta.height!)).toBe(variant === "master" ? 1280 : 640);
    }
    const missing = await visitor.request.get(`${origin}/library-photos/${randomUUID()}/master`);
    expect(missing.status()).toBe(404);
    expect(missing.headers()["cache-control"]).toBe("public, max-age=60");
    expect((await visitor.request.get(`${origin}/library-photos/not-a-uid/master`)).status()).toBe(404);
    // The household route stays private: a visitor is refused, a member does not get a library uid from it.
    const refused = await visitor.request.get(`${origin}/photos/${uid}/master`);
    expect(refused.status()).toBe(401);
    expect(refused.headers()["cache-control"]).toBe("private, no-store");
    const privateMiss = await page.request.get(`/photos/${uid}/master`);
    expect(privateMiss.status()).toBe(404);
    expect(privateMiss.headers()["cache-control"]).toBe("private, no-store");

    // A member sees the shared photo with no way to delete it, and their own upload next to it.
    await page.goto(recipePath);
    const section = page.locator('section[aria-labelledby="photos"]');
    await expect(section.getByText("Shared photo, Synthetic Author", { exact: false })).toBeVisible();
    await expect(section.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Make cover", exact: true })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Add another", exact: true })).toBeEnabled();
    await section.locator('input[type="file"]').setInputFiles({
      name: "synthetic-upload.jpg", mimeType: "image/jpeg",
      buffer: await sharp({ create: { width: 900, height: 600, channels: 3, background: "#c87828" } }).jpeg().toBuffer(),
    });
    await expect(section.getByText("Your photo", { exact: false })).toBeVisible();
    const [recipe] = await handle.db.select({ id: recipes.id }).from(recipes).where(eq(recipes.slug, LIBRARY_PHOTO_RECIPE));
    const [upload] = await handle.db.select({ uid: photos.uid, householdId: photos.householdId }).from(photos).where(and(eq(photos.recipeId, recipe!.id), eq(photos.origin, "upload")));
    expect(upload).toBeDefined();
    await page.reload();
    await expect(section.locator(`img[src="/photos/${upload!.uid}/thumb"]`)).toBeVisible();
    await expect(section.locator(`img[src="/library-photos/${uid}/thumb"]`)).toBeVisible();
    // Your own upload is the cover over the library photo.
    await expect(page.locator(`main img[src="/photos/${upload!.uid}/master"]`).first()).toBeVisible();

    // A second household sees the library photo but nothing of the first household's upload.
    await handle.db.insert(households).values({ id: second.household, name: "Synthetic library second household" });
    await handle.db.insert(authUsers).values({ id: second.user, name: "Synthetic second cook", email: second.email, emailVerified: true });
    await handle.db.insert(authAccounts).values({ id: randomUUID(), userId: second.user, providerId: "credential", accountId: second.user, password: await hashPassword(password) });
    const [profile] = await handle.db.insert(people).values({
      householdId: second.household, name: "Synthetic second profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: people.id });
    await handle.db.insert(householdMembers).values({ householdId: second.household, userId: second.user, role: "owner", personId: profile!.id });
    const client = await browser.newContext({ baseURL: origin });
    contexts.push(client);
    const signedIn = await client.request.post("/api/auth/sign-in/email", { headers: { origin, "x-forwarded-for": "127.0.0.47" }, data: { email: second.email, password } });
    expect(signedIn.status()).toBe(200);
    const other = await client.newPage();
    await other.goto(recipePath);
    const theirs = other.locator('section[aria-labelledby="photos"]');
    await expect(theirs.locator(`img[src="/library-photos/${uid}/thumb"]`)).toBeVisible();
    expect(await other.content()).not.toContain(upload!.uid);
    const foreign = await other.request.get(`/photos/${upload!.uid}/master`);
    expect(foreign.status()).toBe(404);
    expect(foreign.headers()["cache-control"]).toBe("private, no-store");
    await other.goto("/credits");
    await expect(other.getByRole("listitem").filter({ hasText: "Synthetic Author" })).toHaveCount(1);
    await expect(other.getByRole("link", { name: "Review more photos" })).toHaveCount(0);

    // Clean up the upload through the UI so the fixture household is unchanged.
    await page.goto(recipePath);
    await section.getByRole("button", { name: "Delete", exact: true }).click();
    await section.getByRole("button", { name: "Delete photo", exact: true }).click();
    await expect(section.getByText("Your photo", { exact: false })).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close();
    await handle.db.delete(authSessions).where(eq(authSessions.userId, second.user));
    await handle.db.delete(householdMembers).where(eq(householdMembers.householdId, second.household));
    await handle.db.delete(people).where(eq(people.householdId, second.household));
    await handle.db.delete(authAccounts).where(eq(authAccounts.userId, second.user));
    await handle.db.delete(authUsers).where(eq(authUsers.id, second.user));
    await handle.db.delete(households).where(eq(households.id, second.household));
    await handle.close();
  }
});
