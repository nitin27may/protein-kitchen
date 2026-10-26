import { proteinCaption } from "@/lib/food-log/format";

/**
 * Eaten protein as a solid bar and protein still planned but not confirmed as a lighter one after it. A past day with
 * nothing logged says "Not logged" instead of showing zero.
 */
export function EatenProteinBar({ label, eatenG, pendingG, targetG }: { label: string; eatenG: number | null; pendingG: number; targetG: number }) {
  if (eatenG === null) {
    return (
      <div>
        <div className="mb-1 flex items-baseline justify-between text-sm"><span className="font-medium">{label}</span><span className="text-muted">Not logged</span></div>
        <div className="h-2.5 w-full rounded-full bg-surface2" role="img" aria-label={`${label}: not logged`} />
      </div>
    );
  }
  const eatenPct = targetG > 0 ? Math.min(100, (eatenG / targetG) * 100) : 0;
  const pendingPct = targetG > 0 ? Math.min(100 - eatenPct, (pendingG / targetG) * 100) : 0;
  const caption = proteinCaption(eatenG, pendingG, targetG);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums"><strong>{Math.round(eatenG)}</strong> of {Math.round(targetG)} g eaten</span>
      </div>
      <div role="img" aria-label={`${label}: ${caption}`} className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface2">
        <div className="h-full bg-primary" style={{ width: `${eatenPct}%` }} />
        <div className="h-full bg-primary/30" style={{ width: `${pendingPct}%` }} />
      </div>
      <p className="mt-1 text-sm text-muted tabular-nums" data-testid="eaten-caption">{caption}</p>
    </div>
  );
}
