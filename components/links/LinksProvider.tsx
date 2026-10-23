"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { moveLink, removeLink } from "@/app/actions";
import { LinkEditor } from "@/components/links/LinkEditor";
import type { EditorScope } from "@/components/links/LinkEditor";
import { VideoSheet } from "@/components/links/VideoSheet";
import { Banner, Button } from "@/components/ui";
import type { LinkTargetPart, OwnedLink } from "@/lib/recipes/linkview";

interface EditorState {
  key: number;
  link: OwnedLink | null;
  preset: EditorScope | null;
}

interface LinksContextValue {
  recipeSlug: string;
  links: OwnedLink[];
  parts: LinkTargetPart[];
  partName: (slug: string) => string | null;
  play: (link: OwnedLink) => void;
  openAdd: (preset?: EditorScope) => void;
  openEdit: (link: OwnedLink) => void;
  remove: (link: OwnedLink) => void;
  move: (link: OwnedLink, direction: "up" | "down") => void;
  busy: boolean;
}

const Ctx = createContext<LinksContextValue | null>(null);

export function useLinks(): LinksContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLinks must be used inside LinksProvider");
  return v;
}

/**
 * Holds the links for one recipe page, the single video sheet and the single editor, so a link on the recipe, on a
 * part or on a step all open the same ones. Saves go through server actions and then refresh the page data.
 */
export function LinksProvider({ recipeSlug, links, parts, mealStepCount, children }: { recipeSlug: string; links: OwnedLink[]; parts: LinkTargetPart[]; mealStepCount: number; children: ReactNode }) {
  const router = useRouter();
  const [playing, setPlaying] = useState<OwnedLink | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [seq, setSeq] = useState(0);

  const partName = useCallback((slug: string) => parts.find((p) => p.slug === slug)?.name ?? null, [parts]);

  const run = useCallback(
    (job: () => Promise<{ ok: boolean; error?: string }>) => {
      setError(null);
      start(async () => {
        const r = await job();
        if (!r.ok) setError(r.error ?? "Could not save the change.");
        else router.refresh();
      });
    },
    [router],
  );

  const value = useMemo<LinksContextValue>(
    () => ({
      recipeSlug,
      links,
      parts,
      partName,
      busy,
      play: (link) => setPlaying(link),
      openAdd: (preset) => {
        setSeq((n) => n + 1);
        setEditor({ key: seq + 1, link: null, preset: preset ?? null });
      },
      openEdit: (link) => {
        setSeq((n) => n + 1);
        setEditor({ key: seq + 1, link, preset: null });
      },
      remove: (link) => run(() => removeLink(link.id)),
      move: (link, direction) => run(() => moveLink(link.id, direction)),
    }),
    [recipeSlug, links, parts, partName, busy, run, seq],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {playing ? <VideoSheet key={playing.id} link={playing} onClose={() => setPlaying(null)} /> : null}
      {editor ? (
        <LinkEditor
          key={editor.key}
          recipeSlug={recipeSlug}
          parts={parts}
          mealStepCount={mealStepCount}
          link={editor.link}
          preset={editor.preset}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            router.refresh();
          }}
        />
      ) : null}
      {error ? (
        <div className="fixed inset-x-0 bottom-20 z-50 mx-auto w-full max-w-md px-4 lg:bottom-6" role="alert">
          <Banner tone="bad" title="Could not change the link">
            <p>{error}</p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => setError(null)}>Dismiss</Button>
          </Banner>
        </div>
      ) : null}
    </Ctx.Provider>
  );
}
