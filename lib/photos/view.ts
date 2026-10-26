/** One photo as a page shows it. Household rows come from `photos`, library rows from the shared manifest. */
export interface PhotoView {
  uid: string;
  url: string;
  thumbUrl: string;
  isCover: boolean;
  origin: "upload" | "commons" | "openverse";
  /** Whose photo it is: only a household photo can be removed or made the cover by that household. */
  scope: "household" | "library";
  width: number;
  height: number;
  /** Credit line parts for approved candidates; empty for your own photos. */
  title: string | null;
  author: string | null;
  licence: string | null;
  licenceUrl: string | null;
  sourceUrl: string | null;
}

/** One line of the public credits page. */
export interface CreditedPhoto {
  uid: string;
  subjectKind: "recipe" | "ingredient";
  subjectSlug: string;
  scope: "household" | "library";
  title: string | null;
  author: string | null;
  licence: string | null;
  licenceUrl: string | null;
  sourceUrl: string | null;
}
