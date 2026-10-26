"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { commitLegacyImport, previewLegacyImport, type LegacyImportResult } from "@/app/settings/legacy-import-actions";
import { Banner, Button, Field, Select, inputClass } from "@/components/ui";

type Checked = Extract<LegacyImportResult, { ok: true }>;

const LABELS: Record<string, string> = {
  people: "People", preferences: "Likes and avoids", recipe_feedback: "Ratings and notes", recipe_links: "Recipe links",
  saved_views: "Saved views", person_routines: "Routine choices", pantry: "Pantry", habit_log: "Habit log",
  plan_setups: "Plan setups", plans: "Plans", plan_slots: "Planned meals", plan_slot_portions: "Portions", plan_routines: "Plan routines",
  grocery_state: "Grocery ticks", grocery_manual: "Manual grocery items", plan_part_state: "Part choices", plan_progress: "Plan progress",
  prep_task_state: "Prep ticks",
};

export function LegacyImportPanel() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [checked, setChecked] = useState<Checked | null>(null);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const form = (confirm?: string): FormData | null => {
    const file = fileInput.current?.files?.[0];
    if (!file) { setError("Choose the bundle file first."); return null; }
    const data = new FormData();
    data.set("bundle", file);
    if (link) data.set("link_person", link);
    if (confirm) data.set("confirm_sha256", confirm);
    return data;
  };
  const reset = () => { setChecked(null); setDone(""); setError(""); setLink(""); };

  return <section aria-label="Import from the old app" className="space-y-3 rounded-card border border-line bg-surface p-4">
    <h2 className="text-lg font-semibold">Import from the old app</h2>
    <p className="text-sm text-muted">Bring your ratings, notes, links, saved views, routines, pantry and habit log from the old single-household app into this household. Build the bundle file on your own computer from a copy of the old database; it never leaves your hands until you choose it here. Library recipes, photos and reminders are not included. The import only fills an empty household and runs once.</p>
    {done ? <>
      <p role="status" className="text-sm">{done}</p>
      <Button className="min-h-11" variant="secondary" onClick={reset}>Import another bundle</Button>
    </> : <>
      <Field label="Bundle file" htmlFor="legacy-bundle" hint="A .json file under 4 MB.">
        <input id="legacy-bundle" ref={fileInput} type="file" accept="application/json,.json" className={inputClass} onChange={() => { setChecked(null); setError(""); }} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" loading={pending && !checked} onClick={() => start(async () => {
          setError(""); setChecked(null);
          const data = form(); if (!data) return;
          try {
            const result = await previewLegacyImport(data);
            if (result.ok) setChecked(result); else setError(result.error);
          } catch { setError("The check could not be reached. Check your connection and try again."); }
        })}>Check the bundle</Button>
      </div>
      {checked ? <div className="space-y-3" aria-label="Dry run result">
        <Banner tone="info" title="Dry run: nothing has been imported yet">
          This is what would be added to this household. {checked.withPlans ? "Plans are included." : "Plans are not included."}
        </Banner>
        <table className="w-full text-left text-sm">
          <thead><tr><th scope="col" className="py-1 pr-3">Kind</th><th scope="col" className="py-1 pr-3">Added</th><th scope="col" className="py-1">Left out</th></tr></thead>
          <tbody>{Object.keys(checked.report.imported).map((name) =>
            <tr key={name} className="border-t border-line"><td className="py-1 pr-3">{LABELS[name] ?? name}</td><td className="py-1 pr-3">{checked.report.imported[name]}</td><td className="py-1">{checked.report.skipped[name] ?? 0}</td></tr>)}
          </tbody>
        </table>
        {(["recipes", "ingredients", "habits"] as const).map((kind) => checked.report.unknown[kind].length
          ? <p key={kind} className="text-sm text-muted">Not in this app's library, so left out ({kind}): {checked.report.unknown[kind].join(", ")}</p> : null)}
        {checked.people.length ? <Field label="Which person are you?" htmlFor="legacy-link" hint="Optional. Your account takes this profile, and your empty starter profile is removed.">
          <Select id="legacy-link" value={link} onChange={(e) => setLink(e.target.value)}>
            <option value="">Keep my current profile</option>
            {checked.people.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </Select>
        </Field> : null}
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" loading={pending} onClick={() => start(async () => {
            setError("");
            const data = form(checked.sha256); if (!data) return;
            try {
              const result = await commitLegacyImport(data);
              if (result.ok) { setDone("Import finished. Your old data is now in this household."); setChecked(null); router.refresh(); }
              else setError(result.error);
            } catch { setError("The import could not be reached. Nothing was changed. Check your connection and try again."); }
          })}>Import into this household</Button>
          <Button className="min-h-11" variant="secondary" disabled={pending} onClick={reset}>Cancel</Button>
        </div>
      </div> : null}
    </>}
    {error ? <Banner tone="bad">{error}</Banner> : null}
  </section>;
}
