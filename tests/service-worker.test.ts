import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("never intercepts private pages, auth routes or server-component requests", () => {
  type Event = { request: Request; respondWith: (value: Promise<Response>) => void };
  const handlers = new Map<string, (event: Event) => void>();
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self: { addEventListener: (name: string, handler: (event: Event) => void) => handlers.set(name, handler), location: { origin: "https://kitchen.example.test" } },
    URL, Response, fetch: vi.fn().mockResolvedValue(Response.json({})),
    caches: { open: vi.fn().mockResolvedValue({ put: vi.fn() }) },
  });

  const handler = handlers.get("fetch")!;
  for (const route of ["/", "/account", "/onboarding", "/groceries", "/sign-in", "/api/auth/get-session", "/?_rsc=synthetic"]) {
    const respondWith = vi.fn();
    handler({ request: new Request(`https://kitchen.example.test${route}`), respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  }
  const respondWith = vi.fn();
  handler({ request: new Request("https://kitchen.example.test/_next/static/synthetic.js"), respondWith });
  expect(respondWith).toHaveBeenCalledOnce();
});

it("precaches only a public icon and removes the old private-page cache on activation", async () => {
  const handlers = new Map<string, (event: { waitUntil: (value: Promise<unknown>) => void }) => void>();
  const addAll = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(true);
  const claim = vi.fn().mockResolvedValue(undefined);
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self: {
      addEventListener: (name: string, handler: (event: { waitUntil: (value: Promise<unknown>) => void }) => void) => handlers.set(name, handler),
      skipWaiting: vi.fn(), clients: { claim },
    },
    caches: {
      open: vi.fn().mockResolvedValue({ addAll }),
      keys: vi.fn().mockResolvedValue(["pk-v1", "pk-static-v2"]), delete: remove,
    },
  });
  let done = Promise.resolve<unknown>(undefined);
  const event = { waitUntil: (value: Promise<unknown>) => { done = value; } };
  handlers.get("install")!(event);
  await done;
  expect(addAll).toHaveBeenCalledWith(["/icon.svg"]);
  handlers.get("activate")!(event);
  await done;
  expect(remove).toHaveBeenCalledExactlyOnceWith("pk-v1");
  expect(claim).toHaveBeenCalledOnce();
});
