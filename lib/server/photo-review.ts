import type { Candidate } from "../photos/candidates";

export type SubjectKind = "recipe" | "ingredient";

export interface ReviewItem {
  kind: SubjectKind;
  slug: string;
  name: string;
  /** Candidates not yet approved or rejected for this subject. */
  candidates: Candidate[];
  /** True when the subject already has a library photo, so candidates are optional extras. */
  hasPhoto: boolean;
  /** Library photos the subject already keeps (the cap is 3), so the page can warn before a selection overshoots. */
  photoCount: number;
}

export interface ReviewFilter {
  kind?: SubjectKind | "all";
  q?: string;
  /** Hide subjects that already have a photo. */
  onlyWithoutPhoto?: boolean;
}
