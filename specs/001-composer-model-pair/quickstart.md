# Validation Quickstart: Composer Model-Pair Persistence

This guide validates the planned change against existing repository boundaries.
Run commands from the indicated package directory; do not mutate Git history or
the index.

## Prerequisites

- Dependencies installed with Bun.
- App browser-test preload available at packages/app/happydom.ts.
- Playwright Chromium installed for the user-story test.
- No unrelated working-tree changes when interpreting diff checks.

## Focused app validation

    cd /Users/do/git/opencode/packages/app
    bun test --conditions=solid --preload ./happydom.ts \
      ./src/pages/session/composer/prompt-model-selection.test.ts \
      ./src/context/prompt-state.test.ts
    bun test --conditions=browser --preload ./happydom.ts \
      ./test-browser/composer-model-pair.test.tsx \
      ./test-browser/composer-model-commands.test.tsx \
      ./test-browser/local-model-selection.test.tsx \
      ./test-browser/prompt-input-model-pair.test.tsx
    bun run typecheck
    bun run test:e2e -- e2e/user-story/model-selection-flow.spec.ts

Expected evidence:

1. Legacy PromptInput selection of fallback B invokes the shared pair callback,
   yields primary B/fallback A, and preserves each model's supported variant.
2. Legacy primary variant changes invoke the pair callback; no direct
   selection.set or selection.variant.set is used by composer controls.
3. Current command/V2 tests still show the same pair instance is authoritative,
   including hidden configured fallback augmentation.
4. A second accepted action remains unmutated and unsent while first controlled
   persistence is pending; after failure/resolution it starts from settled state.
5. Primary failure restores exact raw primary model/variant and preserves a
   concurrent agent change. Fallback-only failure does not change primary state.
6. Concurrent unrelated recent/visibility/saved-variant changes remain present
   after pair failure; failed pair-owned preference effects are absent until
   success.
7. Successful selection retains ordinary recent, visibility, and saved-variant
   behavior.

## Backend regression validation

    cd /Users/do/git/opencode/packages/opencode
    bun test \
      test/session/retry.test.ts \
      test/session/processor-effect.test.ts \
      test/session/prompt.test.ts

Expected result: all three existing backend suites pass unchanged. Environment-
specific FSEvents failures, if present and unchanged, must be reported separately
and must not be classified as composer regressions.

## Repository hygiene validation

    cd /Users/do/git/opencode
    git diff --check
    git diff --cached --check

Expected result: no whitespace errors. The plan does not include Git history/index
mutation.
