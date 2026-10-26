/**
 * Screen an ingredients statement (English and French) against the household diet: lacto-vegetarian, no eggs,
 * no gelatin, no animal rennet. Pure. It flags, it never blocks: a person decides.
 *
 * "May contain" and facility statements become a note, not a flag.
 */

export type DietFlagKind = "egg" | "gelatin" | "rennet" | "meat" | "fish" | "uncertain";

export interface DietFlag {
  kind: DietFlagKind;
  /** Short label for the thing found, such as "egg" or "L-cysteine". */
  label: string;
  message: string;
  /** The words found in the text (folded to lower case, accents removed). */
  matches: string[];
}

export interface DietScreen {
  flags: DietFlag[];
  suggestions: { is_dairy: boolean; contains_onion_garlic: boolean };
  notes: string[];
}

interface Rule {
  kind: DietFlagKind;
  label: string;
  /** Terms already folded: lower case, no accents, "oe" for the ligature. */
  terms: readonly string[];
  /** Message template: how the flag reads. */
  message: string;
}

const RULES: readonly Rule[] = [
  { kind: "egg", label: "egg", terms: ["egg", "albumen", "ovalbumin", "lysozyme", "oeuf", "blanc d oeuf", "jaune d oeuf"], message: "Contains egg (from ingredients)" },
  { kind: "gelatin", label: "gelatin", terms: ["gelatin", "gelatine"], message: "Contains gelatin (from ingredients)" },
  { kind: "rennet", label: "rennet", terms: ["rennet", "presure", "animal enzymes", "enzymes animales"], message: "Contains animal rennet or enzymes (from ingredients)" },
  {
    kind: "meat",
    label: "meat",
    terms: [
      "meat", "chicken", "beef", "pork", "lard", "tallow", "collagen", "bone", "lamb", "veal", "turkey", "ham", "bacon",
      "viande", "poulet", "boeuf", "porc", "saindoux", "suif", "collagene", "os", "agneau", "veau", "dinde", "jambon",
    ],
    message: "Contains meat (from ingredients)",
  },
  { kind: "fish", label: "fish", terms: ["fish", "anchovy", "anchovies", "tuna", "salmon", "shrimp", "poisson", "anchois", "thon", "saumon", "crevette"], message: "Contains fish or seafood (from ingredients)" },
  { kind: "uncertain", label: "L-cysteine", terms: ["l cysteine", "cysteine"], message: "L-cysteine: source unknown, check with the maker (from ingredients)" },
  { kind: "uncertain", label: "carmine", terms: ["carmine", "cochineal", "cochenille", "e120"], message: "Carmine or cochineal: made from insects (from ingredients)" },
  { kind: "uncertain", label: "shellac", terms: ["shellac", "gomme laque"], message: "Shellac: made from insects (from ingredients)" },
];

const DAIRY_TERMS = [
  "milk", "cream", "butter", "cheese", "whey", "lactose", "casein", "caseinate", "yogurt", "yoghurt", "ghee", "paneer", "curd", "buttermilk", "milkfat",
  "lait", "creme", "beurre", "fromage", "lactoserum", "yaourt", "caseine", "caseinate",
];

const ONION_GARLIC_TERMS = ["onion", "garlic", "shallot", "scallion", "oignon", "ail", "echalote"];

/** Phrases that look like an ingredient but say the product is free of it, or name a non-animal source. */
const NEGATING = [
  /\b(?:egg|meat|gelatin|gelatine|lard|fish|dairy|milk)[ -]free\b/g,
  /\b(?:sans|without|no) (?:oeufs?|gelatine|gelatin|viande|egg|eggs|meat)\b/g,
  /\b(?:microbial|vegetable|vegetarian|non[- ]animal|fungal|plant|microbienne|vegetale|vegetal) (?:rennet|enzymes?|presure|gelatin|gelatine)\b/g,
  /\b(?:presure|enzymes?) (?:microbienne|vegetale|vegetal|d origine (?:microbienne|vegetale))\b/g,
  /\b(?:coconut|almond|soy|soya|oat|rice|cashew|hemp|pea|nut|plant|vegetable) (?:milk|cream|butter|cheese|yogurt|yoghurt)\b/g,
  /\b(?:cocoa|cacao|shea|peanut|nut|almond|cashew|sunflower seed) butter\b/g,
  /\b(?:lait|creme|beurre|fromage|yaourt) (?:de |d )(?:coco|amande|soja|soya|avoine|riz|cajou|noix|cacao|arachide|karite)\b/g,
  /\beggplant\b/g,
  /\b(?:cream of tartar|creme de tartre)\b/g,
];

const MAY_CONTAIN = /\b(?:may contain|peut contenir|contains traces of|traces? (?:of|de|d)|produced in a facility|made in a facility|manufactured in a facility|processed in a facility|fabrique dans (?:une|un) (?:usine|installation|etablissement)|produit dans (?:une|un) (?:usine|installation|etablissement))[^.;]*/g;

/** Lower case, accents removed, ligatures expanded, apostrophes and punctuation to single spaces. */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function termRegex(terms: readonly string[]): RegExp {
  const alt = terms.join("|");
  return new RegExp(`(?<![a-z0-9])(?:${alt})(?:s|x)?(?![a-z0-9])`, "g");
}

function findAll(text: string, terms: readonly string[]): string[] {
  return [...new Set([...text.matchAll(termRegex(terms))].map((m) => m[0]))];
}

export function screenIngredients(raw: string): DietScreen {
  // Split off "may contain" statements before folding punctuation away.
  const notes: string[] = [];
  const preFolded = raw.toLowerCase().replace(/œ/g, "oe").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const rawStatements = [...preFolded.matchAll(MAY_CONTAIN)].map((m) => m[0].trim());
  for (const s of rawStatements) notes.push(`Not treated as an ingredient: "${s}"`);
  let text = foldText(preFolded.replace(MAY_CONTAIN, " "));
  for (const re of NEGATING) text = text.replace(re, " ");

  const flags: DietFlag[] = [];
  for (const rule of RULES) {
    const matches = findAll(text, rule.terms);
    if (matches.length > 0) flags.push({ kind: rule.kind, label: rule.label, message: rule.message, matches });
  }

  return {
    flags,
    suggestions: {
      is_dairy: findAll(text, DAIRY_TERMS).length > 0,
      contains_onion_garlic: findAll(text, ONION_GARLIC_TERMS).length > 0,
    },
    notes,
  };
}
