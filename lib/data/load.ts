import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { HabitSchema, IngredientSchema, MicrosFileSchema, RecipeSchema, TechniqueFrontMatterSchema } from "../schemas";
import type { Habit, Ingredient, MicrosFile, Recipe } from "../schemas";

export interface LoadIssue {
  file: string;
  message: string;
}

export interface TechniqueDoc {
  title: string;
  tags: string[];
  body: string;
}

export interface DataSet {
  ingredients: Map<string, Ingredient>;
  ingredientFiles: Map<string, string>;
  recipes: Map<string, Recipe>;
  recipeFiles: Map<string, string>;
  techniques: Map<string, TechniqueDoc>;
  micros: MicrosFile;
  habits: Habit[];
  overrides: { kcal_check_skip: Record<string, string>; dry_without_cooked_yield: Record<string, string> };
  issues: LoadIssue[];
}

const OverridesSchema = z.object({
  kcal_check_skip: z.record(z.string(), z.string()),
  dry_without_cooked_yield: z.record(z.string(), z.string()),
});

function readJson(file: string, issues: LoadIssue[]): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    issues.push({ file, message: `invalid JSON: ${(e as Error).message}` });
    return undefined;
  }
}

function listFiles(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, ext);
    return entry.name.endsWith(ext) ? [full] : [];
  });
}

export function loadData(root: string): DataSet {
  const issues: LoadIssue[] = [];
  const dataDir = path.join(root, "data");
  const rel = (f: string) => path.relative(root, f);

  const ingredients = new Map<string, Ingredient>();
  const ingredientFiles = new Map<string, string>();
  for (const file of listFiles(path.join(dataDir, "ingredients"), ".json")) {
    const raw = readJson(file, issues);
    if (raw === undefined) continue;
    const parsed = z.array(IngredientSchema).safeParse(raw);
    if (!parsed.success) {
      for (const err of parsed.error.issues) {
        issues.push({ file: rel(file), message: `${err.path.join(".")}: ${err.message}` });
      }
      continue;
    }
    for (const ing of parsed.data) {
      if (ingredients.has(ing.slug)) {
        issues.push({ file: rel(file), message: `duplicate ingredient slug "${ing.slug}" (also in ${ingredientFiles.get(ing.slug)})` });
        continue;
      }
      ingredients.set(ing.slug, ing);
      ingredientFiles.set(ing.slug, rel(file));
    }
  }

  const recipes = new Map<string, Recipe>();
  const recipeFiles = new Map<string, string>();
  // Meals live in data/recipes, parts of meals (components) in data/components. Each is <root>/<family>/<slug>.json.
  const recipeFilesOnDisk = [
    ...listFiles(path.join(dataDir, "recipes"), ".json").map((file) => ({ file, root: "recipes" as const })),
    ...listFiles(path.join(dataDir, "components"), ".json").map((file) => ({ file, root: "components" as const })),
  ];
  for (const { file, root: kindRoot } of recipeFilesOnDisk) {
    const raw = readJson(file, issues);
    if (raw === undefined) continue;
    const parsed = RecipeSchema.safeParse(raw);
    if (!parsed.success) {
      for (const err of parsed.error.issues) {
        issues.push({ file: rel(file), message: `${err.path.join(".")}: ${err.message}` });
      }
      continue;
    }
    const recipe = parsed.data;
    if (path.basename(file, ".json") !== recipe.slug) {
      issues.push({ file: rel(file), message: `file name does not match slug "${recipe.slug}"` });
    }
    if (kindRoot === "components" && recipe.kind !== "component") {
      issues.push({ file: rel(file), message: `"${recipe.slug}" is a recipe and must live in data/recipes/${recipe.family}/, not data/components` });
    }
    if (kindRoot === "recipes" && recipe.kind === "component") {
      issues.push({ file: rel(file), message: `"${recipe.slug}" is a component and must live in data/components/${recipe.family}/, not data/recipes` });
    }
    if (path.basename(path.dirname(file)) !== recipe.family) {
      issues.push({ file: rel(file), message: `folder does not match family "${recipe.family}"` });
    }
    if (recipes.has(recipe.slug)) {
      issues.push({ file: rel(file), message: `duplicate recipe slug "${recipe.slug}"` });
      continue;
    }
    recipes.set(recipe.slug, recipe);
    recipeFiles.set(recipe.slug, rel(file));
  }

  const techniques = new Map<string, TechniqueDoc>();
  for (const file of listFiles(path.join(dataDir, "techniques"), ".md")) {
    const slug = path.basename(file, ".md");
    const { data, content } = matter(fs.readFileSync(file, "utf8"));
    const fm = TechniqueFrontMatterSchema.safeParse(data);
    if (!fm.success) {
      for (const err of fm.error.issues) issues.push({ file: rel(file), message: `front-matter ${err.path.join(".")}: ${err.message}` });
    }
    const words = content.trim().split(/\s+/).length;
    if (words < 150 || words > 400) issues.push({ file: rel(file), message: `body is ${words} words, expected 150 to 400` });
    techniques.set(slug, { title: fm.success ? fm.data.title : slug, tags: fm.success ? fm.data.tags : [], body: content.trim() });
  }

  const microsPath = path.join(dataDir, "nutrients", "micros.json");
  let micros: MicrosFile = {};
  const microsRaw = fs.existsSync(microsPath) ? readJson(microsPath, issues) : undefined;
  if (microsRaw !== undefined) {
    const parsed = MicrosFileSchema.safeParse(microsRaw);
    if (parsed.success) micros = parsed.data;
    else for (const err of parsed.error.issues) issues.push({ file: rel(microsPath), message: `${err.path.join(".")}: ${err.message}` });
  }

  let habits: Habit[] = [];
  const habitsPath = path.join(dataDir, "habits.json");
  if (fs.existsSync(habitsPath)) {
    const raw = readJson(habitsPath, issues);
    const parsed = z.array(HabitSchema).safeParse(raw);
    if (parsed.success) habits = parsed.data;
    else if (raw !== undefined) for (const err of parsed.error.issues) issues.push({ file: rel(habitsPath), message: `${err.path.join(".")}: ${err.message}` });
  }

  let overrides = { kcal_check_skip: {}, dry_without_cooked_yield: {} } as DataSet["overrides"];
  const ovPath = path.join(dataDir, "validation-overrides.json");
  if (fs.existsSync(ovPath)) {
    const raw = readJson(ovPath, issues);
    const parsed = OverridesSchema.safeParse(raw);
    if (parsed.success) overrides = parsed.data;
    else issues.push({ file: rel(ovPath), message: "invalid overrides file" });
  }

  // Photos come from data/images.json (scripts/fetch-images.ts). A hand-set recipe image wins over the manifest.
  const imagesPath = path.join(dataDir, "images.json");
  if (fs.existsSync(imagesPath)) {
    const raw = readJson(imagesPath, issues) as Partial<Record<"recipes" | "ingredients", Record<string, { file: string; credit: string }>>> | undefined;
    for (const [slug, img] of Object.entries(raw?.ingredients ?? {})) {
      const ing = ingredients.get(slug);
      if (ing) ingredients.set(slug, { ...ing, image: img.file, image_credit: img.credit });
    }
    for (const [slug, img] of Object.entries(raw?.recipes ?? {})) {
      const rec = recipes.get(slug);
      if (rec && !rec.image) recipes.set(slug, { ...rec, image: img.file, image_credit: img.credit });
    }
  }

  const notesPath = path.join(dataDir, "ingredient-notes.json");
  if (fs.existsSync(notesPath)) {
    const parsed = z.record(z.string(), z.string().min(10).max(320)).safeParse(readJson(notesPath, issues));
    if (parsed.success) {
      for (const [slug, note] of Object.entries(parsed.data)) {
        const ing = ingredients.get(slug);
        if (ing) ingredients.set(slug, { ...ing, note });
        else issues.push({ file: rel(notesPath), message: `note for unknown ingredient "${slug}"` });
      }
    } else for (const err of parsed.error.issues) issues.push({ file: rel(notesPath), message: `${err.path.join(".")}: ${err.message}` });
  }

  return { ingredients, ingredientFiles, recipes, recipeFiles, techniques, micros, habits, overrides, issues };
}
