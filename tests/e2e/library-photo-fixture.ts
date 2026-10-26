import path from "node:path";
import sharp from "sharp";
import type { Db } from "../../lib/db/client";
import { createFsStore } from "../../lib/blob/fs";
import { approveLibraryCandidate } from "../../lib/human/library-photos";

/** The recipe whose approved library photo the browser fixture starts with. Other specs do not use it. */
export const LIBRARY_PHOTO_RECIPE = "falafel-bowl";

/**
 * Approves one synthetic library photo through the L1 writer, the only way library photos are created. This runs only
 * against the disposable loopback e2e database, before the app serves its first request: the library manifest is cached
 * for an hour, so a photo approved later would not show until the cache is invalidated (L4 does that by tag).
 */
export async function seedLibraryPhoto(db: Db): Promise<void> {
  const result = await approveLibraryCandidate(db, createFsStore(process.env.UPLOADS_DIR ?? path.resolve("test-results/uploads")), {
    candidateKey: "commons:synthetic-library-fixture", origin: "commons", subjectKind: "recipe", subjectSlug: LIBRARY_PHOTO_RECIPE,
    bytes: await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#3a7d44" } }).jpeg().toBuffer(),
    credit: {
      title: "Synthetic library falafel", author: "Synthetic Author", licence: "CC BY-SA 4.0",
      licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/", sourceUrl: "https://commons.example.test/synthetic-falafel",
    },
    licenceCheckedAt: "2026-10-01T00:00:00.000Z", personId: null,
  });
  if (result.status !== "approved") throw new Error(`Library photo fixture was not approved: ${result.status}`);
}
