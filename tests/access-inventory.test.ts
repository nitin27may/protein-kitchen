import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const files = readdirSync("app", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name).replaceAll("\\", "/"));
const publicPages = new Set(["app/sign-in/page.tsx", "app/sign-up/page.tsx", "app/verify-email/page.tsx", "app/reset-password/page.tsx"]);
const admissionPages = new Set(["app/onboarding/page.tsx"]);
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
      expect(firstCall(page!)).toBe("requirePageMember");
      expect(readFileSync(file, "utf8")).toMatch(/export const dynamic = ["']force-dynamic["']/);
    });
  }
  for (const file of files.filter((file) => file.endsWith("/route.ts") && file !== "app/api/auth/[...all]/route.ts")) {
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
        expect(firstCall(node)).toBe("routeAccess");
      });
    }
  }
  it("all legacy actions check membership first, including read-only previews", () => {
    const actions = source("app/actions.ts").statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!exported(node));
    expect(actions).toHaveLength(33);
    for (const action of actions) expect(firstCall(action), action.name?.getText()).toBe("actionDenial");
  });
});
