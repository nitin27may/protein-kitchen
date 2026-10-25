# CI delivery gate

This bounded slice implements the credential-free acceptance prerequisite of
D3 in `plan-v3-publish-and-protect.md`. It does not enable deployments or change
repository protection settings.

## Scope and dependencies

Keep the existing unit/native coverage, data validation, typecheck, build,
browser and secret-scanning jobs. Pin third-party actions to the commits behind
their currently selected major tags. Disable persisted checkout credentials.
Add one `acceptance` job which runs even when a dependency fails or is skipped,
and succeeds only when `ci`, `browser` and `secrets` all report `success`.

## Permission boundaries

No Vercel, Neon, production database or mail/push credentials enter this
workflow. Preserve read-only token permissions. Do not provision resources,
publish releases or modify branch protection in this slice. Once adopted
remotely, `acceptance` can be required alongside or instead of individual checks;
until then, the existing `ci` and `secrets` protections do not require browser
acceptance. A future deployment must verify acceptance for its exact commit.

## Acceptance cases

Retain the executable workflow contract test. Execute the gate shell command for
all combinations of GitHub dependency conclusions: only three successes may
pass; failures, cancellations, skips and absent results must fail. Assert that
the gate lists all dependencies and uses `always()`, every action is pinned,
checkout credentials are not persisted, and test jobs reference no deployment
credentials. Run the targeted contract test before handing off the change.

## Local acceptance

The four retained contract tests pass, including all 125 dependency-result
combinations. Actions are pinned to the resolved commits behind v7 checkout,
v7 setup-node, v6 pnpm setup, v4 artifact upload and v3 Gitleaks. The full
native-inclusive application suite and all 24 browser journeys pass. These
workflow changes have not been pushed or run on GitHub; branch protection
currently requires only `ci` and `secrets`, not `acceptance`.
