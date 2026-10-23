/** Recipe and video links. Human-owned: written through lib/human/links, never by the agent. */
export const LINK_KINDS = ["recipe", "video", "article"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_KIND_LABEL: Record<LinkKind, string> = { recipe: "Recipe page", video: "Video", article: "Article" };

/** A video that can play inside the app. Everything else opens as a normal link. */
export interface LinkEmbed {
  provider: "youtube" | "vimeo";
  /** Privacy-friendly player URL (youtube-nocookie.com or player.vimeo.com), with the start time applied. */
  src: string;
  startSec: number | null;
}

/** What the screens receive. No database ids beyond `id`, which is only used to edit or remove. */
export interface RecipeLinkView {
  id: number;
  uid: string;
  kind: LinkKind;
  url: string;
  title: string;
  source: string | null;
  startSec: number | null;
  /** Component slug when the link belongs to a part of the meal; null for the meal itself. */
  partSlug: string | null;
  /** 1-based step number within the meal (or the part) the link explains; null for the whole thing. */
  stepNo: number | null;
  position: number;
  embed: LinkEmbed | null;
}

export interface LinkInput {
  /** The recipe or component page the link is saved on. */
  recipeSlug: string;
  partSlug?: string | null;
  stepNo?: number | null;
  kind: LinkKind;
  url: string;
  title: string;
  source?: string | null;
  startSec?: number | null;
}
