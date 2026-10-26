import { test, expect } from "./member-fixture";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const pages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page(?![A-Za-z])/g) ?? []).length;
const hasPdftotext = spawnSync("pdftotext", ["-v"]).error === undefined;

function text(pdf: Buffer): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fridge-"));
  const file = path.join(dir, "week.pdf");
  writeFileSync(file, pdf);
  return spawnSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).stdout;
}

test("a member generates a plan and gets a one-page A4 landscape fridge schedule", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto("/plan/new");
  await page.getByRole("button", { name: "Generate plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan\/\d+(\?.*)?$/, { timeout: 60_000 });
  const id = /\/plan\/(\d+)/.exec(page.url())![1]!;

  // The plan page offers the sheet: new tab, no opener, 44 px target, print hint.
  const print = page.getByRole("link", { name: "Print schedule", exact: true });
  await expect(print).toBeVisible();
  await expect(print).toHaveAttribute("target", "_blank");
  await expect(print).toHaveAttribute("rel", /noopener/);
  await expect(print).toHaveAttribute("href", new RegExp(`/api/plan/${id}/schedule`));
  expect((await print.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByText("A4 landscape. Print at 100% scale.").locator("visible=true")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download PDF", exact: true })).toBeVisible();

  const res = await request.get(`/api/plan/${id}/schedule`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect(res.headers()["content-disposition"]).toMatch(/^inline; filename="protein-kitchen-week-\d{4}-\d{2}-\d{2}\.pdf"$/);
  expect(res.headers()["cache-control"]).toBe("private, no-store");
  const pdf = await res.body();
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  expect(pages(pdf)).toBeGreaterThanOrEqual(1);
  expect(pages(pdf)).toBeLessThanOrEqual(2); // a generated plan spans one or two weeks, one page each
  if (hasPdftotext) {
    const out = text(pdf);
    expect(out).toContain("Monday");
    expect(out).toMatch(/Week of Mon \d+ \w+ to Sun \d+ \w+/);
    expect(out).toContain("Breakfast");
  }

  const download = await request.get(`/api/plan/${id}/schedule?download=1&week=1`);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-disposition"]).toMatch(/^attachment; /);
  expect(pages(await download.body())).toBe(1);
});

test("the schedule refuses bad requests and visitors without a session", async ({ request, browser }) => {
  const id = process.env.E2E_PREP_PLAN_ID;
  expect((await request.get("/api/plan/999999999/schedule")).status()).toBe(404);
  expect((await request.get("/api/plan/abc/schedule")).status()).toBe(400);
  expect((await request.get(`/api/plan/${id}/schedule?person=999999999`)).status()).toBe(400);
  expect((await request.get(`/api/plan/${id}/schedule?week=99`)).status()).toBe(400);
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const res = await anonymous.request.get(`http://127.0.0.1:${process.env.E2E_PORT ?? "3112"}/api/plan/${id}/schedule`);
    expect(res.status()).toBe(401);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["content-type"]).not.toContain("pdf");
  } finally { await anonymous.close(); }
});
