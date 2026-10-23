import { Card, LinkButton } from "@/components/ui";
import { formatDay } from "@/lib/planner/dates";
import type { GroceryProgress } from "@/lib/plan/phase";

/** Shopping status for the plan. Shrinks to one line when everything is ticked, and is absent when there is nothing to buy. */
export function GroceryStatusCard({ progress, shopBy, today }: { progress: GroceryProgress; shopBy: string | null; today: string }) {
  if (progress.total === 0) return null;
  if (progress.left === 0) {
    return (
      <p className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3 text-sm">
        <span className="font-semibold text-ok">Shopping done</span>
        <a href="/groceries" className="min-h-11 content-center font-semibold text-primary underline-offset-2 hover:underline lg:min-h-0">View list</a>
      </p>
    );
  }
  const ticked = progress.total - progress.left;
  const by = shopBy ? (shopBy === today ? "today" : formatDay(shopBy).long) : null;
  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Groceries</h2>
        <p className="text-sm text-muted tabular-nums" aria-live="polite">{progress.left} of {progress.total} left</p>
      </div>
      <div role="progressbar" aria-label="Items ticked" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={ticked} className="h-2 w-full overflow-hidden rounded-full bg-surface2">
        <div className="h-full rounded-full bg-primary" style={{ width: `${(ticked / progress.total) * 100}%` }} />
      </div>
      {by ? <p className="text-sm text-muted">Shop by <span className="font-semibold text-fg">{by}</span>.</p> : null}
      <LinkButton href="/groceries" variant="secondary" className="w-full">Open list</LinkButton>
    </Card>
  );
}
