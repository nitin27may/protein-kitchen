import { describe, expect, it } from "vitest";
import type { ProfileInitial } from "../components/ProfileForm";
import { AnonProfileSchema } from "../lib/plan/anon-draft";
import { profilePrefill } from "../lib/plan/profile-prefill";

const initial: ProfileInitial = {
  name: "Account name", sex: "other", birthDate: "", heightCm: "", weightKg: "", activityLevel: "moderate",
  proteinMode: "per_kg", proteinValue: 1.2, kcalTarget: "", reminderTime: "",
};

describe("profilePrefill", () => {
  it("changes nothing without a device profile", () => {
    expect(profilePrefill(null, initial)).toEqual({ initial, filled: false });
  });

  it("carries a fixed protein target, name and calories", () => {
    const anon = AnonProfileSchema.parse({ name: "Asha", protein: { mode: "fixed", grams: 90 }, kcalTarget: 2200 });
    const { initial: out, filled } = profilePrefill(anon, initial);
    expect(filled).toBe(true);
    expect(out).toMatchObject({ name: "Asha", proteinMode: "fixed", proteinValue: 90, kcalTarget: 2200, weightKg: "" });
  });

  it("carries grams per kg with the weight", () => {
    const anon = AnonProfileSchema.parse({ name: "Ravi", protein: { mode: "perKg", gPerKg: 1.6, weightKg: 82 } });
    expect(profilePrefill(anon, initial).initial).toMatchObject({ name: "Ravi", proteinMode: "per_kg", proteinValue: 1.6, weightKg: 82, kcalTarget: "" });
  });

  it("keeps the account name when the device name is the default", () => {
    const anon = AnonProfileSchema.parse({ protein: { mode: "fixed", grams: 100 } });
    expect(anon.name).toBe("You");
    expect(profilePrefill(anon, initial).initial.name).toBe("Account name");
  });

  it("never fills sex, birth date, height, activity or reminder", () => {
    const anon = AnonProfileSchema.parse({ name: "Asha", protein: { mode: "perKg", gPerKg: 1.2, weightKg: 70 } });
    expect(profilePrefill(anon, initial).initial).toMatchObject({ sex: "other", birthDate: "", heightCm: "", activityLevel: "moderate", reminderTime: "" });
  });
});
