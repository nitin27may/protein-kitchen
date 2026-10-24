import { describe, expect, it } from "vitest";
import { PersonInput, personRow, ReminderTimezone } from "../lib/schemas/person";
import { isReminderDue, localParts } from "../lib/reminders/due";

const profile = {
  name: "Synthetic cook", sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
  activityLevel: "moderate" as const, proteinMode: "per_kg" as const, proteinValue: 1.2,
  kcalTarget: null, reminderTime: "21:00",
};

describe("validated per-cook reminder timezone", () => {
  it.each(["America/Toronto", "Asia/Kolkata", "Pacific/Auckland", "UTC"])("accepts IANA zone %s", (zone) => {
    expect(PersonInput.parse({ ...profile, reminderTimezone: zone }).reminderTimezone).toBe(zone);
    expect(personRow({ ...profile, reminderTimezone: zone }).reminderTimezone).toBe(zone);
  });
  it.each(["", " ", "Not/A_Zone", "America/Toronto\0", "a".repeat(101)])("refuses invalid timezone %s", (zone) => {
    const result = PersonInput.safeParse({ ...profile, reminderTimezone: zone });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.flatten().fieldErrors.reminderTimezone).toBeDefined();
  });
  it("trims validated input while leaving old profiles on the household fallback", () => {
    expect(ReminderTimezone.parse(" Asia/Kolkata ")).toBe("Asia/Kolkata");
    expect(personRow(PersonInput.parse({ ...profile, reminderTimezone: " Asia/Kolkata " })).reminderTimezone).toBe("Asia/Kolkata");
    expect(personRow(PersonInput.parse(profile)).reminderTimezone).toBeNull();
    expect(personRow(PersonInput.parse({ ...profile, reminderTimezone: null })).reminderTimezone).toBeNull();
  });
  it("uses each cook's own local date across midnight instead of the household calendar", () => {
    const now = new Date("2026-10-24T15:30:00Z");
    expect(localParts(now, "Asia/Kolkata")).toEqual({ date: "2026-10-24", hhmm: "21:00" });
    expect(localParts(now, "Pacific/Auckland").date).toBe("2026-10-25");
    expect(isReminderDue("21:00", now, "Asia/Kolkata", false)).toBe(true);
    expect(isReminderDue("21:00", now, "America/Toronto", false)).toBe(false);
  });
  it("keeps the local-day suppression key through a repeated DST hour", () => {
    for (const iso of ["2026-11-01T05:15:00Z", "2026-11-01T06:15:00Z"]) {
      const now = new Date(iso);
      expect(localParts(now, "America/Toronto")).toEqual({ date: "2026-11-01", hhmm: "01:15" });
      expect(isReminderDue("01:00", now, "America/Toronto", false)).toBe(true);
      expect(isReminderDue("01:00", now, "America/Toronto", true)).toBe(false);
    }
  });
});
