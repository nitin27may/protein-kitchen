"use client";

import { useState, useTransition } from "react";
import { addLink, updateLink } from "@/app/actions";
import { Sheet } from "@/components/Sheet";
import { Banner, Button, Field, Input, Segmented, Select } from "@/components/ui";
import { LINK_KINDS, LINK_KIND_LABEL } from "@/lib/links/types";
import type { LinkInput, LinkKind } from "@/lib/links/types";
import { joinStartTime, looksLikeVideoUrl, MAX_SOURCE, MAX_TITLE, splitStartTime } from "@/lib/recipes/linkview";
import type { LinkTargetPart, OwnedLink } from "@/lib/recipes/linkview";

/** Where the editor starts, when it is opened from a part card or a step. */
export type EditorScope = { scope: "whole" } | { scope: "part"; partSlug: string } | { scope: "step"; partSlug: string | null; stepNo?: number };

type Scope = "whole" | "part" | "step";

function initialScope(link: OwnedLink | null, preset: EditorScope | null, parts: LinkTargetPart[]) {
  if (link) {
    if (link.stepNo !== null) return { scope: "step" as Scope, partSlug: parts[0]?.slug ?? "", stepIn: link.partSlug ?? "meal", stepNo: link.stepNo };
    if (link.partSlug) return { scope: "part" as Scope, partSlug: link.partSlug, stepIn: "meal", stepNo: 1 };
    return { scope: "whole" as Scope, partSlug: parts[0]?.slug ?? "", stepIn: "meal", stepNo: 1 };
  }
  if (preset?.scope === "part") return { scope: "part" as Scope, partSlug: preset.partSlug, stepIn: "meal", stepNo: 1 };
  if (preset?.scope === "step") return { scope: "step" as Scope, partSlug: parts[0]?.slug ?? "", stepIn: preset.partSlug ?? "meal", stepNo: preset.stepNo ?? 1 };
  return { scope: "whole" as Scope, partSlug: parts[0]?.slug ?? "", stepIn: "meal", stepNo: 1 };
}

/**
 * Add or change a link. Links open other websites; the app keeps only the address, the title written here and the
 * source name. Errors from the server show beside the field they belong to.
 */
export function LinkEditor({ recipeSlug, parts, mealStepCount, link, preset, onClose, onSaved }: { recipeSlug: string; parts: LinkTargetPart[]; mealStepCount: number; link: OwnedLink | null; preset: EditorScope | null; onClose: () => void; onSaved: () => void }) {
  const editing = link !== null;
  // A link saved on a part's own page stays there; only its text can change from a meal page.
  const lockedTarget = editing && link.ownerSlug !== recipeSlug;
  const start = splitStartTime(link?.startSec);
  const init = initialScope(link, preset, parts);

  const [kind, setKind] = useState<LinkKind>(link?.kind ?? "recipe");
  const [kindTouched, setKindTouched] = useState(editing);
  const [url, setUrl] = useState(link?.url ?? "");
  const [title, setTitle] = useState(link?.title ?? "");
  const [source, setSource] = useState(link?.source ?? "");
  const [min, setMin] = useState(start.min);
  const [sec, setSec] = useState(start.sec);
  const [scope, setScope] = useState<Scope>(init.scope);
  const [partSlug, setPartSlug] = useState(init.partSlug);
  const [stepIn, setStepIn] = useState(init.stepIn);
  const [stepNo, setStepNo] = useState(init.stepNo);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, startSave] = useTransition();

  const stepCount = stepIn === "meal" ? mealStepCount : (parts.find((p) => p.slug === stepIn)?.stepCount ?? 0);
  const safeStepNo = Math.min(Math.max(1, stepNo), Math.max(1, stepCount));
  const noTargets = scope === "part" && parts.length === 0;
  const noSteps = scope === "step" && stepCount === 0;

  function changeUrl(v: string) {
    setUrl(v);
    setFields((f) => ({ ...f, url: "" }));
    if (!kindTouched && looksLikeVideoUrl(v)) setKind("video");
  }

  function save() {
    setError(null);
    setFields({});
    const target = lockedTarget
      ? { partSlug: null, stepNo: link.stepNo }
      : scope === "part"
        ? { partSlug, stepNo: null }
        : scope === "step"
          ? { partSlug: stepIn === "meal" ? null : stepIn, stepNo: safeStepNo }
          : { partSlug: null, stepNo: null };
    const input: LinkInput = {
      recipeSlug: lockedTarget ? link.ownerSlug : recipeSlug,
      partSlug: target.partSlug,
      stepNo: target.stepNo,
      kind,
      url: url.trim(),
      title: title.trim(),
      source: source.trim() || null,
      startSec: kind === "video" ? joinStartTime(min, sec) : null,
    };
    startSave(async () => {
      const r = editing ? await updateLink(link.id, input) : await addLink(input);
      if (r.ok) {
        onSaved();
        return;
      }
      setError(r.error);
      setFields(r.fields ?? {});
    });
  }

  const canSave = url.trim().length > 0 && title.trim().length > 0 && !noTargets && !noSteps && !pending;

  return (
    <Sheet open onClose={onClose} title={editing ? "Edit link" : "Add a link"}>
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save();
        }}
      >
        <p className="rounded-control bg-surface2 px-3 py-2 text-sm text-muted">Links open other websites. Protein Kitchen keeps only the address and the title you write here. It never copies their recipe, text or video.</p>

        {error ? <Banner tone="bad">{error}</Banner> : null}

        <div>
          <p className="mb-1 text-sm font-semibold" id="kind-l">What is it?</p>
          <Segmented<LinkKind> value={kind} label="What kind of link" className="w-full" options={LINK_KINDS.map((k) => ({ value: k, label: LINK_KIND_LABEL[k] }))} onChange={(k) => { setKind(k); setKindTouched(true); }} />
        </div>

        <Field label="Address (https)" htmlFor="link-url" error={fields.url}>
          <Input id="link-url" type="url" inputMode="url" autoComplete="off" placeholder="https://" value={url} onChange={(e) => changeUrl(e.target.value)} aria-invalid={fields.url ? true : undefined} />
        </Field>

        <Field label="Title, in your own words" htmlFor="link-title" error={fields.title} hint={`${title.length} of ${MAX_TITLE}`}>
          <Input id="link-title" maxLength={MAX_TITLE} placeholder="For example: Crisp baked falafel, step by step" value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={fields.title ? true : undefined} />
        </Field>

        <Field label="Source (optional)" htmlFor="link-source" error={fields.source} hint={`Channel or website. ${source.length} of ${MAX_SOURCE}`}>
          <Input id="link-source" maxLength={MAX_SOURCE} placeholder="Channel or website name" value={source} onChange={(e) => setSource(e.target.value)} />
        </Field>

        {kind === "video" ? (
          <fieldset>
            <legend className="mb-1 text-sm font-semibold">Start at (optional)</legend>
            <div className="flex items-end gap-2">
              <Field label="Minutes" htmlFor="link-min"><Input id="link-min" inputMode="numeric" className="w-24" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ""))} /></Field>
              <Field label="Seconds" htmlFor="link-sec"><Input id="link-sec" inputMode="numeric" className="w-24" value={sec} onChange={(e) => setSec(e.target.value.replace(/\D/g, ""))} /></Field>
            </div>
            {fields.startSec ? <p className="mt-1 text-sm text-bad" role="alert">{fields.startSec}</p> : null}
          </fieldset>
        ) : null}

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold">Applies to</legend>
          {lockedTarget ? (
            <p className="text-sm text-muted">Saved on the {parts.find((p) => p.slug === link.ownerSlug)?.name ?? "part"} page, so it shows wherever that part is used.</p>
          ) : (
            <>
              <Segmented<Scope> value={scope} label="What the link applies to" className="w-full" options={[{ value: "whole", label: "Whole recipe" }, { value: "part", label: "A part" }, { value: "step", label: "A step" }]} onChange={setScope} />
              {scope === "part" ? (
                parts.length ? (
                  <Field label="Part" htmlFor="link-part">
                    <Select id="link-part" value={partSlug} onChange={(e) => setPartSlug(e.target.value)}>
                      {parts.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                    </Select>
                  </Field>
                ) : (
                  <p className="text-sm text-muted">This recipe has no parts. Choose Whole recipe or A step.</p>
                )
              ) : null}
              {scope === "step" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Steps of" htmlFor="link-stepin">
                    <Select id="link-stepin" value={stepIn} onChange={(e) => { setStepIn(e.target.value); setStepNo(1); }}>
                      <option value="meal">The meal itself</option>
                      {parts.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Step" htmlFor="link-stepno" hint={stepCount === 0 ? "This list has no steps." : undefined}>
                    <Select id="link-stepno" value={safeStepNo} disabled={stepCount === 0} onChange={(e) => setStepNo(Number(e.target.value))}>
                      {Array.from({ length: stepCount }, (_, i) => <option key={i + 1} value={i + 1}>Step {i + 1}</option>)}
                    </Select>
                  </Field>
                </div>
              ) : null}
            </>
          )}
        </fieldset>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="submit" size="lg" loading={pending} disabled={!canSave}>{editing ? "Save changes" : "Add link"}</Button>
          <Button type="button" variant="secondary" size="lg" onClick={onClose} disabled={pending}>Cancel</Button>
        </div>
      </form>
    </Sheet>
  );
}
