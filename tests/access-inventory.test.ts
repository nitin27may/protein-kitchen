import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const files = readdirSync("app", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name).replaceAll("\\", "/"));
const publicPages = new Set(["app/sign-in/page.tsx", "app/sign-up/page.tsx", "app/verify-email/page.tsx", "app/reset-password/page.tsx"]);
const admissionPages = new Set(["app/onboarding/page.tsx"]);
const libraryPages = new Set(["app/page.tsx", "app/recipes/page.tsx", "app/recipes/[slug]/page.tsx", "app/ingredients/page.tsx", "app/ingredients/[slug]/page.tsx"]);
const source = (file: string) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const exported = (node: ts.FunctionDeclaration) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
function firstCall(node: ts.FunctionDeclaration) {
  const statement = node.body?.statements[0];
  if (!statement) return undefined;
  let expression: ts.Expression | undefined;
  if (ts.isVariableStatement(statement)) expression = statement.declarationList.declarations[0]?.initializer;
  if (ts.isExpressionStatement(statement)) expression = statement.expression;
  if (expression && ts.isAwaitExpression(expression) && ts.isCallExpression(expression.expression)) {
    return expression.expression.expression.getText();
  }
}
describe("application authorization inventory", () => {
  for (const file of files.filter((file) => file.endsWith("/page.tsx") && !publicPages.has(file) && !admissionPages.has(file))) {
    it(`${file} checks membership before its loader`, () => {
      const page = source(file).statements.find((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && !!exported(node) && !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
      expect(page, "Use an explicitly guarded page loader; update this inventory for a reviewed alternative.").toBeDefined();
      if (libraryPages.has(file)) {
        const statements = page!.body!.statements;
        const guard = statements.findIndex((statement) => statement.getText().includes("= await requirePageMember();") || statement.getText() === "await requirePageMember();");
        expect(guard, "Private loaders must retain an explicit membership guard after the public branch.").toBeGreaterThan(0);
        const calls: string[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) calls.push(node.expression.getText());
          ts.forEachChild(node, visit);
        };
        for (const statement of statements.slice(0, guard)) visit(statement);
        expect(calls).toContain("optionalPageMember");
        for (const call of calls) expect(["optionalPageMember", "getData", "data.recipes.get", "data.ingredients.get", "notFound"]).toContain(call);
        expect(statements.slice(0, guard).some((statement) => statement.getText().includes("return <Public"))).toBe(true);
      } else if (file === "app/households/page.tsx") {
        const boundary = page!.body!.statements[0];
        expect(ts.isTryStatement(boundary!)).toBe(true);
        if (!boundary || !ts.isTryStatement(boundary)) throw new Error("Household selection requires a verified-session error boundary.");
        expect(boundary.tryBlock.statements[0]?.getText()).toBe("const identity = await verifiedSessionIdentity();");
        expect(boundary.tryBlock.statements[1]?.getText()).toBe("const choices = await sessionHouseholds(await getDb(), identity);");
      } else {
        expect(firstCall(page!)).toBe("requirePageMember");
      }
      expect(readFileSync(file, "utf8")).toMatch(/export const dynamic = ["']force-dynamic["']/);
    });
  }
  it("public library rendering cannot import database, household actions or private projections", () => {
    const imports = source("components/PublicLibrary.tsx").statements.filter(ts.isImportDeclaration);
    const allowed = new Set(["next/link", "./Markdown", "./ui", "@/lib/data/load", "@/lib/data/rules", "@/lib/nutrition/macros", "@/lib/recipes/storage", "@/lib/schemas"]);
    for (const entry of imports) {
      expect(ts.isStringLiteral(entry.moduleSpecifier)).toBe(true);
      expect(allowed.has((entry.moduleSpecifier as ts.StringLiteral).text)).toBe(true);
    }
    expect(readFileSync("components/PublicLibrary.tsx", "utf8")).not.toMatch(/getDb|photoIndex|feedbackMap|setRecipeFeedback|getRecipeLinks|listPeople|listPlans/);
  });
  it("the anonymous library route is public, GET-only, and cannot reach the database or a session", () => {
    const text = readFileSync("app/api/anon-library/route.ts", "utf8");
    const exports = source("app/api/anon-library/route.ts").statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!exported(node));
    expect(exports.map((node) => node.name?.getText())).toEqual(["GET"]);
    expect(text).not.toMatch(/getDb|requireMember|routeAccess|headers\(|cookies\(|request/i);
  });
  for (const file of files.filter((file) => file.endsWith("/route.ts") && file !== "app/api/auth/[...all]/route.ts" && file !== "app/api/anon-library/route.ts")) {
    const statements = source(file).statements;
    it(`${file} uses explicit, reviewable HTTP handler declarations`, () => {
      const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
      expect(statements.some((node) => ts.isFunctionDeclaration(node) && !!exported(node) && methods.has(node.name?.getText() ?? ""))).toBe(true);
      for (const node of statements) {
        if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          expect(node.declarationList.declarations.some((d) => methods.has(d.name.getText()))).toBe(false);
        }
        if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
          expect(node.exportClause.elements.some((e) => methods.has(e.name.getText()))).toBe(false);
        }
      }
    });
    for (const node of statements) {
      if (!ts.isFunctionDeclaration(node) || !exported(node)) continue;
      it(`${file} ${node.name?.getText()} checks request membership first`, () => {
        if (file === "app/api/state-sync/route.ts") {
          expect(node.name?.getText()).toBe("POST");
          expect(node.body?.statements[0]?.getText()).toBe("const auth = schedulerAuthorized(request, process.env);");
          expect(node.body?.statements[1]?.getText()).toContain('auth !== "authorized"');
          return;
        }
        if (file === "app/api/reminders/route.ts") {
          expect(node.name?.getText()).toBe("POST");
          const initial = node.body!.statements.slice(0, 4).map((statement) => statement.getText());
          expect(initial[0]).toBe("const secret = process.env.REMINDER_SCHEDULER_SECRET;");
          expect(initial[1]).toContain("const reused =");
          expect(initial[2]).toContain("const auth = authorizeScheduler(");
          expect(initial[2]).toContain('process.env.REMINDER_SCHEDULER_ENABLED === "true" && !reused');
          expect(initial[2]).toContain('process.env.VERCEL_ENV === "preview"');
          expect(initial[3]).toContain('auth !== "authorized"');
          expect(initial.join("\n")).not.toContain("await");
          return;
        }
        expect(firstCall(node)).toBe("routeAccess");
      });
    }
  }
  it("all legacy actions check membership first, including read-only previews", () => {
    const actions = source("app/actions.ts").statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!exported(node));
    expect(actions).toHaveLength(33);
    for (const action of actions) expect(firstCall(action), action.name?.getText()).toBe("actionDenial");
  });
  it("private-state action checks current owner permission before reading configuration", () => {
    const actions = source("app/settings/sync-actions.ts").statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!exported(node));
    expect(actions).toHaveLength(1);
    expect(firstCall(actions[0]!)).toBe("actionDenial");
    expect(actions[0]!.body?.statements[0]?.getText()).toBe('const denied = await actionDenial("owner");');
  });
  it("admission and account actions resolve the session inside the explicit error boundary", () => {
    const actions = source("app/onboarding/actions.ts").statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!exported(node));
    expect(actions).toHaveLength(13);
    const management = new Set(["changeCookRole", "removeCook"]);
    for (const action of actions) {
      const statement = action.body?.statements[0];
      let expression: ts.Expression | undefined;
      if (statement && ts.isReturnStatement(statement)) expression = statement.expression;
      else if (statement && ts.isVariableStatement(statement)) expression = statement.declarationList.declarations[0]?.initializer;
      if (expression && ts.isAwaitExpression(expression)) expression = expression.expression;
      if (!expression || !ts.isCallExpression(expression)) throw new Error("An account action must run attempt(async () => ...).");
      expect(expression.expression.getText()).toBe("attempt");
      const task = expression.arguments[0];
      expect(task && ts.isArrowFunction(task) && ts.isBlock(task.body)).toBe(true);
      if (!task || !ts.isArrowFunction(task) || !ts.isBlock(task.body)) throw new Error("Missing account action body.");
      const guard = management.has(action.name!.getText()) ? "await requireMember()"
        : action.name!.getText() === "joinHousehold" ? "await verifiedSessionUser()" : "await verifiedSessionIdentity()";
      expect(task.body.statements[0]?.getText()).toContain(guard);
      if (management.has(action.name!.getText())) expect(task.body.statements[1]?.getText()).toBe('checkPermission(actor, "owner");');
    }
  });
});
