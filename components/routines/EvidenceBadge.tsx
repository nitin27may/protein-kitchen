import { Pill } from "@/components/ui";
import type { Tone } from "@/components/ui";
import { GRADE_MEANING, GRADE_WORD } from "@/lib/routines/view";
import type { EvidenceGrade } from "@/lib/routines/types";

const TONE: Record<EvidenceGrade, Tone> = { strong: "ok", moderate: "info", weak: "warn", practical: "info", myth: "bad" };

/** The grade as a word, with what it means. Colour only reinforces the word. */
export function EvidenceBadge({ grade, showMeaning = true }: { grade: EvidenceGrade; showMeaning?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <Pill tone={TONE[grade]}>Evidence: {GRADE_WORD[grade].toLowerCase()}</Pill>
      {showMeaning ? <span className="text-sm text-muted">{GRADE_MEANING[grade]}</span> : null}
    </span>
  );
}
