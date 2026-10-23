/** How a part of a meal (a component such as hummus) is provided for one plan. */
export const PART_MODES = ["make", "buy", "have"] as const;
export type PartMode = (typeof PART_MODES)[number];

/** Component slug to mode. A part with no entry is "make". */
export type PartModes = Record<string, PartMode>;

export const DEFAULT_PART_MODE: PartMode = "make";

export const PART_MODE_LABEL: Record<PartMode, string> = { make: "Make", buy: "Buy", have: "Have" };

export function isPartMode(value: unknown): value is PartMode {
  return typeof value === "string" && (PART_MODES as readonly string[]).includes(value);
}
