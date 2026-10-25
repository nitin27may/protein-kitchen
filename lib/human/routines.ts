import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx } from "../db/tx";
import { TIMES_OF_DAY } from "../routines/types";
import type { TimeOfDay } from "../routines/types";
import type { HumanDataClass } from "./registry";
import { markChanged, newUid, nowIso, stableJson } from "./util";

export const PERSON_ROUTINES_CLASS = "person-routines";

/**
 * The stable key a person goes by in an export: `p-` plus the first 16 hex characters of sha256 of the lower-cased name,
 * a bar and the birth date. People have no uid, and the export must not contain database ids or a birth date, so the
 * file is named by this hash. It survives a restore into a database with different ids; it changes only if the name or
 * birth date is edited, in which case the next export writes the new file and the old one is simply no longer current.
 */
export const personKey = (name: string, birthDate: string): string => `p-${createHash("sha256").update(`${name.trim().toLowerCase()}|${birthDate}`).digest("hex").slice(0, 16)}`;

export interface PersonRoutineInput {
  active: boolean;
  days: number[];
  timeOfDay: TimeOfDay;
  servings: number;
}

type Row = typeof s.personRoutines.$inferSelect;

/**
 * Creates or updates one person's choice of one routine. The only writer of person_routines. Keeps the uid and created_at
 * of an existing row, stamps updated_at and marks the 'person-routines' data class changed in the same transaction.
 */
export async function writePersonRoutine(db: Db, personId: number, habitId: number, input: PersonRoutineInput, createdByPersonId?: number | null): Promise<{ uid: string }> {
  const at = nowIso();
  const [row] = await db.select().from(s.personRoutines).where(and(eq(s.personRoutines.personId, personId), eq(s.personRoutines.habitId, habitId)));
  const uid = row?.uid ?? newUid();
  await withTx(db, async (tx) => {
    const values = { days: input.days, timeOfDay: input.timeOfDay, servings: input.servings, active: input.active, uid, createdAt: row?.createdAt ?? at, updatedAt: at };
    if (row) await tx.update(s.personRoutines).set(values).where(and(eq(s.personRoutines.personId, personId), eq(s.personRoutines.habitId, habitId)));
    else await tx.insert(s.personRoutines).values({ ...values, personId, habitId, createdByPersonId: createdByPersonId ?? null });
    await markChanged(tx, PERSON_ROUTINES_CLASS, at);
  });
  return { uid };
}

const EntrySchema = z.object({
  uid: z.string().min(1),
  habit: z.string().min(1),
  active: z.boolean(),
  days: z.array(z.number().int().min(1).max(7)),
  time_of_day: z.enum(TIMES_OF_DAY),
  servings: z.number().positive(),
  created_at: z.string(),
  updated_at: z.string(),
});
const FileSchema = z.object({ person: z.string().min(1), routines: z.array(EntrySchema) });

const PREFIX = "routines/";

export const personRoutinesClass: HumanDataClass = {
  name: PERSON_ROUTINES_CLASS,
  prefix: PREFIX,

  /** One file per person, named by `personKey`, routines sorted by habit slug. No database ids and no birth date. */
  async exportFiles(db) {
    const people = await db.select({ id: s.people.id, name: s.people.name, birthDate: s.people.birthDate }).from(s.people);
    const keyOf = new Map(people.map((p) => [p.id, personKey(p.name, p.birthDate)]));
    const rows = await db
      .select({ r: s.personRoutines, habit: s.habits.slug })
      .from(s.personRoutines)
      .innerJoin(s.habits, eq(s.habits.id, s.personRoutines.habitId));
    const byPerson = new Map<string, { r: Row; habit: string }[]>();
    for (const x of rows) {
      const key = keyOf.get(x.r.personId);
      if (key) byPerson.set(key, [...(byPerson.get(key) ?? []), x]);
    }
    const files: Record<string, string> = {};
    for (const [key, list] of byPerson) {
      const routines = [...list]
        .sort((a, b) => (a.habit < b.habit ? -1 : a.habit > b.habit ? 1 : 0))
        .map(({ r, habit }) => ({
          uid: r.uid ?? "",
          habit,
          active: r.active,
          days: [...(r.days as number[])].sort((a, b) => a - b),
          time_of_day: r.timeOfDay,
          servings: r.servings,
          created_at: r.createdAt ?? "",
          updated_at: r.updatedAt ?? "",
        }));
      files[`${PREFIX}${key}.json`] = stableJson({ person: key, routines });
    }
    return files;
  },

  /** Adds or updates choices by person and habit. Idempotent. Never deletes. A person or habit that is not here is skipped. */
  async importFiles(db, files) {
    const people = await db.select({ id: s.people.id, name: s.people.name, birthDate: s.people.birthDate }).from(s.people);
    const personByKey = new Map(people.map((p) => [personKey(p.name, p.birthDate), p.id]));
    const habits = await db.select({ id: s.habits.id, slug: s.habits.slug }).from(s.habits);
    const habitBySlug = new Map(habits.map((h) => [h.slug, h.id]));
    let imported = 0;
    const skipped: string[] = [];
    for (const [path, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const f = FileSchema.parse(JSON.parse(text));
      const personId = personByKey.get(f.person);
      if (personId === undefined) {
        skipped.push(path);
        continue;
      }
      for (const e of f.routines) {
        const habitId = habitBySlug.get(e.habit);
        if (habitId === undefined) {
          skipped.push(`${path}#${e.habit}`);
          continue;
        }
        const values = { days: e.days, timeOfDay: e.time_of_day, servings: e.servings, active: e.active, uid: e.uid, createdAt: e.created_at, updatedAt: e.updated_at };
        const [existing] = await db.select({ habitId: s.personRoutines.habitId }).from(s.personRoutines).where(and(eq(s.personRoutines.personId, personId), eq(s.personRoutines.habitId, habitId)));
        if (existing) await db.update(s.personRoutines).set(values).where(and(eq(s.personRoutines.personId, personId), eq(s.personRoutines.habitId, habitId)));
        else await db.insert(s.personRoutines).values({ ...values, personId, habitId });
        imported++;
      }
    }
    return { imported, skipped };
  },
};
