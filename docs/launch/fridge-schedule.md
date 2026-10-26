# Fridge schedule: printable week sheet

Owner request: a printable schedule for the week (breakfast, lunch, snack, dinner for all seven days) in A4 landscape, to print and put on the fridge so anyone can see what to cook. Separate from the data-heavy plan export (`/api/plan/<id>/export`). Stage record required by CLAUDE.md.

## Scope

- `GET /api/plan/<id>/schedule` returns a PDF, one A4 landscape page per plan week.
- A "Print schedule" link and a "Download PDF" link in the "This plan" card on the plan page, with the hint "A4 landscape. Print at 100% scale." When the household has more than one person, a selector chooses Everyone (default) or one person.
- Out of scope: visitors without an account (the anonymous draft plan lives in the browser, so nothing is added there), the Today page (another stage is editing it), recipe photos, nutrition numbers.

## Dependencies

- `lib/export/pdf.ts` font setup (`ensureFonts`, now exported) and pdfmake.
- `getPlanExport` for meals and portions, `buildNight` for the night-before tasks. The route does not call `loadNight`, because that rewrites saved tick keys; a GET must not write.

## Permission boundaries

- `routeAccess` is the first call in the handler (access inventory test). A member of another household gets 404, because the plan is looked up through `getPlanView`, which is household scoped. No session gives 401, an unverified or unlinked account gives 403, as for the export route.
- `Cache-Control: private, no-store` on every response, including errors.
- Reads only. No human-owned table is written.

## Query string

| Parameter | Meaning |
| --- | --- |
| `person=<id>` | Portions for one person. Must be in the plan, else 400. Default: everyone. |
| `week=<n>` | Only that week (1-based). Out of range gives 400. Default: every week. |
| `download=1` | `Content-Disposition: attachment` instead of `inline`. |

Filename: `protein-kitchen-week-<yyyy-mm-dd>.pdf`, dated the first day of the first week printed. Inline by default so a phone opens its PDF viewer.

## Layout

- Title "Week of Mon 2 Nov to Sun 8 Nov", the audience ("For everyone: A, B" or "For A") and "Week 2 of 3" when there are several weeks.
- One row per day (weekday and date), one column per meal slot: Breakfast, Lunch, Snack, Dinner. A Shake column appears only when the plan has shakes.
- Cell: recipe name in bold; below it, smaller, the portion. Everyone mode with several people reads "A: 2 rotis · B: 1 roti", or "Each: 300 g" when all portions match. A leftover reads "Leftovers: <name>" in italics. Nothing planned prints "-".
- "Prep ahead" strip under the table: the night-before tasks for that week by evening ("Sun night: ..."). If they do not fit, it ends with "+N more in the app".
- Black on white, light grey banding, no colour. Margins 28 pt left, right and top, 36 pt bottom.
- Font steps down so seven rows always fit: 13, 12, 11, 10, then 9 pt, then names clipped to 2 lines, then 1 line with an ellipsis. Small text never goes under 9 pt. The builder estimates the height, then checks the real page count of the PDF and steps down again if a week spilled over.

## Acceptance cases

1. A 7-day plan with very long recipe names produces exactly one page (unit test counts `/Type /Page` objects in the bytes).
2. Multi-week plan: one page per week. A short last week still gets its own page.
3. Empty cells print "-"; a Shake column appears only when used.
4. Person selection changes the servings text.
5. Route: 401/403/503 from `routeAccess` return before any data is read; another household's plan is 404; headers are inline, `no-store`, `application/pdf`; `?download=1` is an attachment; bad query values are 400.
6. Browser: a member generates a plan, the plan page shows the link (new tab, `rel=noopener`, at least 44 px tall) and the hint, and the PDF request returns 200 `application/pdf` beginning `%PDF`, one page per week. If `pdftotext` is installed the spec also checks the text contains "Monday" and "Breakfast"; otherwise it checks bytes and page count only. A visitor without a session gets 401.

## Gotchas

- Names are matched by person name in the export rows; two people with the same name in one household would be merged in Everyone mode.
- Recipe names are printed in full only down to the 9 pt level; below that they are clipped.
- Print at 100% scale. "Fit to page" in a print dialog shrinks the text.
