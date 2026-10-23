import Link from "next/link";

/** Links styled as chips, so the chosen person is in the URL and survives a reload. */
export function PersonSwitch({ people, activeId }: { people: { id: number; name: string }[]; activeId: number }) {
  if (people.length < 2) return null;
  return (
    <nav className="flex flex-wrap gap-2 px-4 pb-2" aria-label="Person">
      {people.map((p) => (
        <Link key={p.id} href={`/?p=${p.id}`} aria-current={p.id === activeId ? "page" : undefined}
          className={`inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm font-semibold transition-colors lg:min-h-9 ${p.id === activeId ? "border-primary bg-primarysoft text-primary" : "border-strong bg-surface hover:bg-surface2"}`}>
          {p.name}
        </Link>
      ))}
    </nav>
  );
}
