import { describe, expect, it } from "vitest";
import { buildReminder, isReminderDue, localParts } from "../lib/reminders/due";

const TZ = "America/Toronto";

describe("localParts", () => {
  it("converts to the household time zone, not UTC", () => {
    // 02:30 UTC on 23 Oct is 22:30 on 22 Oct in Toronto (EDT, UTC-4).
    expect(localParts(new Date("2026-10-23T02:30:00Z"), TZ)).toEqual({ date: "2026-10-22", hhmm: "22:30" });
  });
  it("handles the daylight saving change", () => {
    // Clocks go back on 1 Nov 2026. 21:30 local is 01:30 UTC before the change (EDT) and 02:30 UTC after it (EST).
    expect(localParts(new Date("2026-11-02T02:30:00Z"), TZ).hhmm).toBe("21:30");
    expect(localParts(new Date("2026-10-31T01:30:00Z"), TZ).hhmm).toBe("21:30");
  });
});

describe("isReminderDue", () => {
  const at = (iso: string) => new Date(iso);
  it("is due at the reminder time", () => {
    expect(isReminderDue("21:00", at("2026-10-23T01:00:00Z"), TZ, false)).toBe(true);
  });
  it("is due a few minutes late", () => {
    expect(isReminderDue("21:00", at("2026-10-23T01:10:00Z"), TZ, false)).toBe(true);
  });
  it("is not due before the time", () => {
    expect(isReminderDue("21:00", at("2026-10-23T00:59:00Z"), TZ, false)).toBe(false);
  });
  it("does not fire hours late after a restart", () => {
    expect(isReminderDue("21:00", at("2026-10-23T03:00:00Z"), TZ, false)).toBe(false);
  });
  it("sends at most once a day", () => {
    expect(isReminderDue("21:00", at("2026-10-23T01:05:00Z"), TZ, true)).toBe(false);
  });
  it("is off when no time is set", () => {
    expect(isReminderDue(null, at("2026-10-23T01:00:00Z"), TZ, false)).toBe(false);
  });
});

describe("buildReminder", () => {
  it("returns nothing when there is nothing to prepare", () => {
    expect(buildReminder("Nitin", [])).toBeNull();
  });
  it("lists up to three tasks and counts the rest", () => {
    const m = buildReminder("Nitin", ["Soak rajma (200 g), for Rajma masala", "Set dahi, for Raita", "Marinate paneer, for Tikka", "Thaw tofu, for Bowl", "Soak chana, for Chole"]);
    expect(m?.title).toBe("Nitin: prep for tomorrow");
    expect(m?.body).toBe("Soak rajma (200 g); Set dahi; Marinate paneer and 2 more");
  });
});
