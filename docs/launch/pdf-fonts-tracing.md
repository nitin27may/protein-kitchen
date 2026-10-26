# PDF fonts missing on Vercel

## Symptom

`GET /api/plan/[id]/export?format=pdf` failed in production with
`ENOENT ... node_modules/.pnpm/pdfmake@0.3.12/node_modules/pdfmake/build/fonts/Roboto/Roboto-Medium.ttf`.
The route returned its JSON error body instead of a PDF.

## Cause

`ensureFonts` in `lib/export/pdf.ts` finds the Roboto TTFs with `require.resolve("pdfmake/package.json")` and a computed
path. Next.js output file tracing (nft) follows static imports only, so the font files never reached the serverless
bundle. `pdfmake` is also in `serverExternalPackages`, so it is traced as a package, but its `build/fonts` folder is not
referenced from any JS file.

## Fix

`next.config.ts` adds `outputFileTracingIncludes` entries for the two routes that build PDFs:

| Route key | Globs |
| --- | --- |
| `/api/plan/*/export` | `./node_modules/pdfmake/build/fonts/Roboto/*.ttf` |
| `/api/plan/*/schedule` | same (route lands with the fridge schedule PR; the key is harmless until then) |

The export route also now logs a value-free code (`{ format, code }`) and returns
`{ ok: false, error: "The PDF could not be built. Try again later." }` with status 500 and `Cache-Control: private, no-store`.

## Gotchas

- Route keys are picomatch globs. A literal `/api/plan/[id]/export` does not match itself, because `[id]` reads as a
  character class (`i` or `d`). The first attempt used that key and the fonts stayed out of the trace. Use `*`.
- The `./node_modules/pdfmake/...` glob is a symlink under pnpm. nft writes the real path
  (`node_modules/.pnpm/pdfmake@<version>/node_modules/pdfmake/...`), which is what the runtime opens, so it works as is.
- Any future route that calls `buildPdf` needs its key added to `PDF_ROUTES` in `next.config.ts`.

## Verification

```
NEXT_DIST_DIR=.next-build pnpm build
grep -o '[^"]*Roboto[^"]*' ".next-build/server/app/api/plan/[id]/export/route.js.nft.json"
```

Expected: Roboto-Regular, Roboto-Medium, Roboto-Italic and Roboto-MediumItalic under the `.pnpm/pdfmake@...` path. Before
the fix the command prints nothing. `tests/pdf-fonts-tracing.test.ts` fails if the include or the font files go missing.

XLSX (`lib/export/xlsx.ts`, exceljs) builds the workbook in memory and reads no files at runtime, so it needs no include.
