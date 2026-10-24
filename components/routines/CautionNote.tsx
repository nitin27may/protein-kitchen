/** A warning inset. Renders nothing when there is no caution. */
export function CautionNote({ caution }: { caution: string | null | undefined }) {
  if (!caution) return null;
  return (
    <p className="rounded-control border border-warn/30 bg-warnsoft p-3 text-sm text-warn">
      <span className="font-semibold">Be careful: </span>
      {caution}
    </p>
  );
}
