import { describe, expect, it } from "vitest";
import { foldText, screenIngredients } from "@/lib/foods/diet-screen";

const kinds = (t: string) => screenIngredients(t).flags.map((f) => f.kind);
const messages = (t: string) => screenIngredients(t).flags.map((f) => f.message);

describe("foldText", () => {
  it("lower-cases, strips accents and ligatures, folds punctuation", () => {
    expect(foldText("Gélatine, ŒUFS; l'ail")).toBe("gelatine oeufs l ail");
    expect(foldText("Æther")).toBe("aether");
    expect(foldText("")).toBe("");
  });
});

describe("egg", () => {
  it("a pancake mix with egg powder flags egg", () => {
    const r = screenIngredients("Enriched wheat flour, sugar, leavening (baking soda), egg powder, salt, buttermilk powder");
    expect(r.flags.map((f) => f.kind)).toContain("egg");
    expect(r.flags.find((f) => f.kind === "egg")?.message).toBe("Contains egg (from ingredients)");
    expect(r.suggestions.is_dairy).toBe(true);
  });
  it.each(["Egg white", "dried albumen", "Ovalbumin", "lysozyme (from egg)", "EGGS", "Oeufs entiers", "œufs", "jaune d'œuf", "blanc d’oeuf"])("%s", (t) => {
    expect(kinds(t)).toContain("egg");
  });
  it("does not flag eggplant or egg-free claims", () => {
    expect(kinds("eggplant, tomatoes")).toEqual([]);
    expect(kinds("Egg-free mayonnaise: oil, water")).toEqual([]);
    expect(kinds("sans oeufs, farine")).toEqual([]);
    expect(kinds("without egg")).toEqual([]);
  });
});

describe("gelatin and rennet", () => {
  it("gelatin EN and FR", () => {
    expect(kinds("sugar, gelatin")).toEqual(["gelatin"]);
    expect(kinds("sucre, gélatine")).toEqual(["gelatin"]);
  });
  it("rennet EN and FR, animal enzymes", () => {
    expect(kinds("milk, salt, rennet")).toEqual(["rennet"]);
    expect(kinds("lait, présure, sel")).toEqual(["rennet"]);
    expect(kinds("milk, animal enzymes")).toEqual(["rennet"]);
    expect(kinds("lait, enzymes animales")).toEqual(["rennet"]);
  });
  it("microbial, vegetable and non-animal sources are not flagged", () => {
    expect(kinds("milk, microbial rennet")).toEqual([]);
    expect(kinds("milk, vegetable rennet")).toEqual([]);
    expect(kinds("lait, présure microbienne")).toEqual([]);
    expect(kinds("lait, enzymes d'origine microbienne")).toEqual([]);
    expect(kinds("vegetable gelatin substitute")).toEqual([]);
    expect(kinds("gelatin-free gummies")).toEqual([]);
  });
});

describe("meat and fish", () => {
  it.each(["chicken fat", "beef extract", "pork", "lard", "tallow", "bone broth", "collagen casing", "meat", "turkey", "bacon bits", "Viande", "poulet", "boeuf", "porc", "saindoux", "suif", "collagène", "dinde", "jambon", "agneau", "veau"])("meat: %s", (t) => {
    expect(kinds(t)).toEqual(["meat"]);
  });
  it.each(["fish sauce", "anchovy paste", "anchovies", "tuna", "poisson", "anchois", "thon", "crevettes", "saumon"])("fish: %s", (t) => {
    expect(kinds(t)).toEqual(["fish"]);
  });
  it("messages", () => {
    expect(messages("lard, anchovy")).toEqual(["Contains meat (from ingredients)", "Contains fish or seafood (from ingredients)"]);
  });
  it("meat-free and lard-free claims are not flagged", () => {
    expect(kinds("meat-free crumbles (soy protein)")).toEqual([]);
  });
});

describe("uncertain sources", () => {
  it("L-cysteine, carmine, cochineal, shellac, E120", () => {
    expect(kinds("dough conditioner (L-cysteine)")).toEqual(["uncertain"]);
    expect(messages("L-cysteine")[0]).toMatch(/source unknown/);
    expect(kinds("colour (carmine)")).toEqual(["uncertain"]);
    expect(kinds("cochineal extract")).toEqual(["uncertain"]);
    expect(kinds("cochenille")).toEqual(["uncertain"]);
    expect(kinds("E120")).toEqual(["uncertain"]);
    expect(kinds("confectioner's glaze, shellac")).toEqual(["uncertain"]);
    expect(screenIngredients("carmine, shellac").flags.map((f) => f.label)).toEqual(["carmine", "shellac"]);
  });
});

describe("may contain", () => {
  it("is a note, not a flag", () => {
    const r = screenIngredients("Flour, sugar. May contain egg, milk and soy.");
    expect(r.flags).toEqual([]);
    expect(r.suggestions.is_dairy).toBe(false);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/may contain egg, milk and soy/);
  });
  it("French and facility statements", () => {
    expect(screenIngredients("Farine. Peut contenir des oeufs.").flags).toEqual([]);
    expect(screenIngredients("Farine. Produit dans une usine qui utilise des oeufs.").notes).toHaveLength(1);
    expect(screenIngredients("Flour. Made in a facility that processes egg; traces of nuts").notes).toHaveLength(2);
    expect(screenIngredients("Farine. Traces d'oeufs").flags).toEqual([]);
  });
  it("still flags a real ingredient listed before the statement", () => {
    const r = screenIngredients("Flour, egg yolk. May contain milk.");
    expect(r.flags.map((f) => f.kind)).toEqual(["egg"]);
    expect(r.suggestions.is_dairy).toBe(false);
  });
});

describe("dairy and onion/garlic suggestions", () => {
  it.each(["skim milk powder", "butter", "cheddar cheese", "whey protein", "lactose", "sodium caseinate", "yoghurt", "ghee", "paneer", "lait écrémé", "crème", "beurre", "fromage", "lactosérum", "yaourt", "cream"])("dairy: %s", (t) => {
    expect(screenIngredients(t).suggestions.is_dairy).toBe(true);
  });
  it.each(["coconut milk", "almond milk, sugar", "cocoa butter", "peanut butter", "shea butter", "lait de coco", "beurre de cacao", "beurre d'arachide", "oat milk", "cream of tartar", "crème de tartre", "soy milk"])("not dairy: %s", (t) => {
    expect(screenIngredients(t).suggestions.is_dairy).toBe(false);
  });
  it.each(["onion powder", "garlic", "ail", "oignon", "échalote", "shallots", "scallion"])("onion/garlic: %s", (t) => {
    expect(screenIngredients(t).suggestions.contains_onion_garlic).toBe(true);
  });
  it("neither", () => {
    const r = screenIngredients("rice, salt");
    expect(r.suggestions).toEqual({ is_dairy: false, contains_onion_garlic: false });
    expect(r.flags).toEqual([]);
    expect(r.notes).toEqual([]);
  });
  it("word boundaries: tail is not ail, hamburger is not ham", () => {
    expect(screenIngredients("tail").suggestions.contains_onion_garlic).toBe(false);
    expect(kinds("hamburger bun")).toEqual([]);
  });
  it("empty text", () => {
    expect(screenIngredients("")).toEqual({ flags: [], suggestions: { is_dairy: false, contains_onion_garlic: false }, notes: [] });
  });
});
