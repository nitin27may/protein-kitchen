import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FoodBadges } from "@/components/foods/FoodBadges";
import { FoodOwnerActions } from "@/components/foods/FoodOwnerActions";
import { LabelPhotoViewer } from "@/components/foods/LabelPhotoViewer";
import { Banner, Card, PageTitle } from "@/components/ui";
import { memberHouseholdAccess } from "@/lib/auth/household-access";
import { screenIngredients } from "@/lib/foods/diet-screen";
import { MICRO_LABELS } from "@/lib/nutrition/labels";
import { getDb } from "@/lib/server/context";
import { getHouseholdFood, type FoodDetail } from "@/lib/server/food-queries";

export const metadata: Metadata = { title: "Food" };
export const dynamic = "force-dynamic";

const fmt = (n: number, digits = 1) => n.toLocaleString("en-CA", { maximumFractionDigits: digits });
const BASIS: Record<FoodDetail["labelBasis"], string> = { per_serving: "per serving", per_100g: "per 100 g", per_100ml: "per 100 ml" };

function servingText(f: FoodDetail): string | null {
  const parts = [f.servingLabel, f.servingG !== null ? `${fmt(f.servingG)} g` : null, f.servingMl !== null ? `${fmt(f.servingMl)} ml` : null].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export default async function FoodPage({ params, searchParams }: { params: Promise<{ uid: string }>; searchParams: Promise<{ saved?: string }> }) {
  const member = await requirePageMember();
  const { uid } = await params;
  const { saved } = await searchParams;
  const db = await getDb();
  const access = await memberHouseholdAccess(db, member);
  const food = await getHouseholdFood(db, access.householdId, uid);
  if (!food) notFound();
  const owner = member.role === "owner";
  const serving = servingText(food);
  const reported = MICRO_LABELS.filter((m) => food.per100gMicros[m.key] !== undefined);
  const flags = screenIngredients(food.ingredientsText ?? "").flags;
  const savedCount = saved === undefined ? null : Number(saved);
  return (
    <>
      <PageTitle title={food.name} sub={food.brand ?? undefined} action={<Link href="/foods" className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-primary">All foods</Link>} />
      <div className="space-y-4 px-4 pb-10 lg:px-2">
        {savedCount !== null && Number.isInteger(savedCount) ? (
          <Banner tone="ok" title="Saved">
            {savedCount > 0 ? `This changes ${savedCount} past ${savedCount === 1 ? "entry" : "entries"}.` : "No past entries use this food yet."}
          </Banner>
        ) : null}
        <FoodBadges source={food.source} estimatedWeight={food.estimatedWeight} archived={food.archived} />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4">
            <Card>
              <h2 className="text-lg font-semibold">Per 100 g</h2>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                <Stat label="Energy" value={`${fmt(food.kcal, 0)} kcal`} />
                <Stat label="Protein" value={`${fmt(food.proteinG)} g`} />
                <Stat label="Carbohydrate" value={`${fmt(food.carbsG)} g`} />
                <Stat label="Fat" value={`${fmt(food.fatG)} g`} />
                <Stat label="Fibre" value={food.fibreG === null ? "not reported" : `${fmt(food.fibreG)} g`} />
              </dl>
              {reported.length ? (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 sm:grid-cols-3">
                  {reported.map((m) => <Stat key={m.key} label={m.label} value={`${fmt(food.per100gMicros[m.key]!, m.digits)} ${m.unit}`} />)}
                </dl>
              ) : null}
              <p className="mt-3 text-sm text-muted">{food.notReported.length} other nutrients are not reported. They are left out of totals, never counted as zero.</p>
              {food.estimatedWeight ? <p className="mt-2 text-sm text-muted">The weight per millilitre is an estimate (1 ml as 1 g), so these figures are approximate.</p> : null}
            </Card>
            <Card>
              <h2 className="text-lg font-semibold">As the label says</h2>
              <p className="mt-1 text-sm">Values {BASIS[food.labelBasis]}{serving ? `. Serving: ${serving}` : ""}.</p>
              {food.pieceG !== null ? <p className="text-sm text-muted">One {food.pieceLabel ?? "piece"} is {fmt(food.pieceG)} g.</p> : null}
              <p className="mt-2 text-sm text-muted">Confirmed {new Date(food.confirmedAt).toLocaleDateString("en-CA")}{food.confirmedByName ? ` by ${food.confirmedByName}` : ""}.</p>
            </Card>
            <Card>
              <h2 className="text-lg font-semibold">Ingredients and our diet</h2>
              {food.ingredientsText ? <p className="mt-1 text-sm">{food.ingredientsText}</p> : <p className="mt-1 text-sm text-muted">No ingredients saved.</p>}
              <div className="mt-2 space-y-2">
                {flags.map((f) => <Banner key={`${f.kind}-${f.label}`} tone="warn" title={f.message} />)}
              </div>
              <p className="mt-2 text-sm text-muted">
                {[food.isDairy ? "Contains dairy" : null, food.containsOnionGarlic ? "Contains onion or garlic" : null, food.dietCheckedAt ? "Checked for our diet" : "Not checked for our diet"].filter(Boolean).join(". ")}.
              </p>
            </Card>
          </div>
          <div className="space-y-4">
            {food.hasLabelPhoto ? <LabelPhotoViewer uid={food.uid} name={food.name} /> : <Card><p className="text-sm text-muted">No label photo.</p></Card>}
            <Card>
              <p className="text-base font-semibold">Used in {food.usageCount} {food.usageCount === 1 ? "entry" : "entries"}</p>
              <p className="text-sm text-muted">Food log entries that use this food.</p>
            </Card>
            {owner ? <FoodOwnerActions uid={food.uid} archived={food.archived} usageCount={food.usageCount} source={food.source} hasPhoto={food.hasLabelPhoto} /> : null}
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-sm text-muted">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd></div>;
}
