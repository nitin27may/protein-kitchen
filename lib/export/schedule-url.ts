/** Link to the fridge sheet PDF. `personId` null prints for everyone. */
export function scheduleUrl(planId: number, personId: number | null, download = false): string {
  const q = new URLSearchParams();
  if (personId !== null) q.set("person", String(personId));
  if (download) q.set("download", "1");
  const query = q.toString();
  return `/api/plan/${planId}/schedule${query ? `?${query}` : ""}`;
}
