# Fix flaky e2e tests

Scope: two browser tests failed once each in CI and passed on rerun. Each had a real cause.

## 1. Anonymous plan journey (tests/e2e/anonymous-plan.spec.ts)

Two separate races, found by running the journey 15 and 30 times locally with a unique email per repeat.

- Product bug (lib/server/anon-import.ts). After signup the server rebuilds the plan from the draft seed using the member's
  own target, then re-applies the meals the person chose. A leftover lunch (same recipe as last night's dinner) was rejected
  by the "recipe suits this slot" check when the recipe is dinner-only, so the server kept its own lunch and the saved plan
  differed from the draft. It only shows when the member's target makes the server build different dinners from the device,
  so it depended on the random seed (about 1 in 15 runs). A draft leftover is now accepted when it repeats the dinner of the
  day before in the final plan and passes the ban and avoid checks. Covered by a seed sweep in tests/anon-import.test.ts.
- Test race. The swap check read the first meal once right after the "Swapped to" notice, but the notice and the list render
  separately. It now waits with `expect(...).not.toHaveText(before)`.

## 2. Photo upload failure (tests/e2e/household-plan.spec.ts)

The file input and Add button had no handler until hydration, so a file picked early fired a change event nobody handled and
no error appeared ("element(s) not found" on the alert). Reproduced deterministically by delaying the page scripts. PhotoUpload
and the PhotosCard buttons are now disabled until hydrated (same pattern as PlanClient and SetupForm), and the test waits for
the button to be enabled before picking the file.

## Log line

`The destination stream errored while writing data` comes from Next when the client closes a request while the response is
still streaming (navigation, reload, aborted route). Not seen in the local runs; treated as benign client aborts.
