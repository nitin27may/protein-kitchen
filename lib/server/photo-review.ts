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
}

export interface ReviewFilter {
  kind?: SubjectKind | "all";
  q?: string;
  /** Hide subjects that already have a photo. */
  onlyWithoutPhoto?: boolean;
}
