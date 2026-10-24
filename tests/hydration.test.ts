import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";
import { useHydrated } from "../lib/hooks/use-hydrated";

vi.mock("react", () => ({ useSyncExternalStore: vi.fn() }));

describe("stable hydration signal", () => {
  it("keeps server controls disabled and enables client controls without subscriptions or changing snapshot identities", () => {
    vi.mocked(useSyncExternalStore).mockImplementation((subscribe, client, server) => {
      expect(server!()).toBe(false);
      expect(client()).toBe(true);
      const changed = vi.fn();
      const unsubscribe = subscribe(changed);
      unsubscribe();
      expect(changed).not.toHaveBeenCalled();
      return client();
    });
    expect(useHydrated()).toBe(true);
    expect(useHydrated()).toBe(true);
    const [first, second] = vi.mocked(useSyncExternalStore).mock.calls;
    expect(second).toEqual(first);
  });
});
