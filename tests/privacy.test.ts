import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION_DAYS } from "../lib/deployment/neon-snapshot";
import { DRAFT_TTL_MS, INTENT_TTL_MS, MIRROR_TTL_MS } from "../lib/plan/anon-draft";
import { CONTACT_NOT_SET, privacyContact } from "../lib/privacy-contact";
import { EMAIL_CODE_TTL_SECONDS } from "../lib/auth/email-code";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => { vi.unstubAllEnvs(); });

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
async function privacyPage() {
  const { default: Privacy } = await import("../app/privacy/page");
  return html(Privacy());
}
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&rsquo;/g, "’").replace(/\s+/g, " ");

describe("privacy contact", () => {
  it("uses only the configured address", () => {
    expect(privacyContact({ PRIVACY_CONTACT_EMAIL: " privacy@example.test " })).toEqual({ kind: "address", email: "privacy@example.test" });
    expect(privacyContact({ PRIVACY_CONTACT_EMAIL: "privacy@example.test", VERCEL_ENV: "production" })).toEqual({ kind: "address", email: "privacy@example.test" });
  });
  it("says so when unset outside production, and shows nothing in production", () => {
    for (const value of [undefined, "", "   ", "not an address", "a@b", "<x@example.test>"]) {
      expect(privacyContact({ PRIVACY_CONTACT_EMAIL: value })).toEqual({ kind: "not-set" });
      expect(privacyContact({ PRIVACY_CONTACT_EMAIL: value, VERCEL_ENV: "preview" })).toEqual({ kind: "not-set" });
      expect(privacyContact({ PRIVACY_CONTACT_EMAIL: value, VERCEL_ENV: "production" })).toEqual({ kind: "hidden" });
    }
  });
  it("reads process.env by default", () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "from-env@example.test");
    expect(privacyContact()).toEqual({ kind: "address", email: "from-env@example.test" });
  });
});

describe("privacy page", () => {
  const sections = ["store", "device", "email", "where", "backups", "download", "delete", "contact"];

  it("renders every section with the contact address when the variable is set", async () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "privacy@example.test");
    const markup = await privacyPage();
    for (const id of sections) expect(markup, id).toContain(`id="${id}-heading"`);
    expect(markup).toContain('href="mailto:privacy@example.test"');
    expect(text(markup)).not.toContain(CONTACT_NOT_SET);
  });

  it("renders every section and the placeholder when the variable is unset outside production", async () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "");
    vi.stubEnv("VERCEL_ENV", "");
    const markup = await privacyPage();
    for (const id of sections) expect(markup, id).toContain(`id="${id}-heading"`);
    expect(text(markup)).toContain(CONTACT_NOT_SET);
    expect(markup).not.toContain("mailto:");
  });

  it("never invents an address in production when the variable is missing", async () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "");
    vi.stubEnv("VERCEL_ENV", "production");
    const markup = await privacyPage();
    for (const id of sections) expect(markup, id).toContain(`id="${id}-heading"`);
    expect(text(markup)).not.toContain(CONTACT_NOT_SET);
    expect(markup).not.toContain("mailto:");
    expect(text(markup)).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  });

  it("has one h1 and then h2 headings only, in order, each section labelled by its heading", async () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "privacy@example.test");
    const markup = await privacyPage();
    const levels = [...markup.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBe(2);
    expect(levels).toHaveLength(sections.length + 1);
    for (const id of sections) expect(markup).toContain(`aria-labelledby="${id}-heading"`);
  });

  it("uses descriptive link text and no empty or generic links", async () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "privacy@example.test");
    const links = [...(await privacyPage()).matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => ({ href: m[1]!, label: text(m[2]!).trim() }));
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const { label } of links) {
      expect(label.length).toBeGreaterThan(3);
      expect(label).not.toMatch(/^(here|click here|link|read more|more)$/i);
    }
    expect(links.map((l) => l.href)).toEqual(expect.arrayContaining(["/account", "mailto:privacy@example.test"]));
  });

  it("states the durations the code actually uses", async () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "privacy@example.test");
    const body = text(await privacyPage());
    const day = 24 * 60 * 60 * 1000;
    expect(body).toContain(`${DRAFT_TTL_MS / day} days after the draft was made`);
    expect(body).toContain(`for ${MIRROR_TTL_MS / 60_000} minutes`);
    expect(body).toContain(`up to ${INTENT_TTL_MS / (60 * 60 * 1000)} hours`);
    expect(body).toContain(`expire after ${EMAIL_CODE_TTL_SECONDS / 60 === 5 ? "five" : "?"} minutes`);
    expect(body).toContain(`keep it for up to ${DEFAULT_RETENTION_DAYS} days`);
    expect(body).toContain(`for up to ${DEFAULT_RETENTION_DAYS} days`);
  });

  it("does not claim off-site dumps, marketing, or anything about selling beyond what it says", async () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "privacy@example.test");
    const body = text(await privacyPage());
    expect(body).not.toMatch(/off-site|offsite|encrypted dump/i);
    expect(body).toContain("We do not send marketing email");
    expect(body).toMatch(/Vercel/);
    expect(body).toMatch(/Neon, in US East \(Ohio\)/);
    expect(body).toMatch(/Resend/);
    expect(body).toMatch(/Neon object storage/);
  });

  it("is static: no database, session, header or server module is reachable from it", () => {
    for (const file of ["app/privacy/page.tsx", "components/PrivacyContent.tsx", "lib/privacy-contact.ts", "app/account-deleted/page.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/getDb|requireMember|requirePageMember|optionalPageMember|headers\(|cookies\(|lib\/(db|server|auth|human)\//);
    }
  });
});

describe("account deleted page", () => {
  it("confirms deletion, mentions the backup window and links on", async () => {
    const { default: AccountDeleted } = await import("../app/account-deleted/page");
    const markup = html(AccountDeleted());
    expect(text(markup)).toContain("Your account has been deleted");
    expect(text(markup)).toContain(`up to ${DEFAULT_RETENTION_DAYS} days`);
    expect(markup).toContain('href="/privacy#delete"');
    expect(markup).toContain('href="/sign-in"');
    expect([...markup.matchAll(/<h([1-6])\b/g)].map((m) => m[1])).toEqual(["1"]);
  });
});

describe("privacy links in the shell", () => {
  it.each(["visitor", "setup", "member"] as const)("the sidebar footer links to /privacy for %s", async (account) => {
    const { Sidebar } = await import("../components/Sidebar");
    const markup = html(createElement(Sidebar, { account, photoReview: false }));
    expect(markup).toMatch(/<a[^>]*href="\/privacy"[^>]*>Privacy<\/a>/);
  });

  it("the sign-in form links to /privacy as 'How we use your email', embedded or not", async () => {
    const { AuthScreen } = await import("../components/auth/AuthScreen");
    for (const props of [{ initial: "code" as const }, { initial: "password" as const }, { initial: "code" as const, embedded: true }]) {
      expect(html(createElement(AuthScreen, props))).toMatch(/<a[^>]*href="\/privacy"[^>]*>How we use your email<\/a>/);
    }
  });

  it("the account page links to /privacy", () => {
    expect(readFileSync("app/account/page.tsx", "utf8")).toContain('href="/privacy"');
  });

  it("the delete control explains the sole-member and shared cases", async () => {
    const { DeleteAccountControls } = await import("../components/auth/DeleteAccountControls");
    const sole = text(html(createElement(DeleteAccountControls, { email: "a@example.test", hasPassword: false, onlyMember: true })));
    expect(sole).toContain("also deletes the household");
    const shared = text(html(createElement(DeleteAccountControls, { email: "a@example.test", hasPassword: true, onlyMember: false })));
    expect(shared).toContain("Other people share your household");
  });
});
