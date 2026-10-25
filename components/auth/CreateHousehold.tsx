"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createHousehold } from "@/app/onboarding/actions";
import { Banner, Button, Field, Input } from "@/components/ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";

export function CreateHousehold() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  return (
    <form className="space-y-4" onSubmit={async (event) => {
      event.preventDefault();
      setPending(true); setError(""); setFieldError("");
      try {
        const result = await createHousehold(name);
        if (!result.ok) {
          setError(result.error); setFieldError(result.fields?.form ?? "");
          return;
        }
        router.refresh();
      } catch {
        setError("Your household could not be created. Check your connection and try again.");
      } finally { setPending(false); }
    }}>
      <h2 className="text-lg font-semibold">Create your household</h2>
      <p className="text-sm text-muted">Start a separate household for your shared meals. You will manage it automatically; existing household data is never moved.</p>
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <fieldset disabled={!hydrated || pending} className="space-y-4">
        <Field label="Household name" htmlFor="household-name" error={fieldError}>
          <Input id="household-name" required maxLength={100} autoComplete="off"
            value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Button type="submit" size="lg" loading={pending}>Create household</Button>
      </fieldset>
    </form>
  );
}
