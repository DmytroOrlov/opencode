---

description: "Narrow implementation task list for composer model-pair persistence simplification"
---

# Tasks: Consistent Composer Model-Pair Persistence

**Input**: Design documents from `/Users/do/git/opencode/specs/001-composer-model-pair/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, and `.specify/memory/constitution.md`

**Scope**: Existing-code simplification only. The existing `ModelPairController`, controller-local promise-tail FIFO, current-layout wiring, awaited server refresh, fallback semantics, and exact raw rollback behavior remain authoritative. No setup, dependency, scaffolding, Git-history, backend, TLS, telemetry, routing, generated-SDK, generic transaction, generic queue, or unrelated selector work is included.

## Phase 1: User-story contract tests first

These tests expose the remaining legacy bypass and deferred-preference contract before production changes. They are the first implementation work and may be done in parallel because they modify different test files.

### User Story 1 - Consistent selection in both composer layouts (Priority: P1)

**Goal**: Prove the real legacy PromptInput model-control seam must use the shared pair authority for primary and variant actions.

**Independent test**: With primary A, fallback B, and model-specific variants, exercise paid and unpaid legacy selectors; selecting B produces primary B/fallback A with variants attached to their models, and the legacy controls do not call direct model selection setters.

- [X] T001 [P] [US1] Add failing seam-level coverage in `packages/app/test-browser/prompt-input-model-pair.test.tsx` using the actual legacy `PromptInput` controls: verify paid and unpaid primary callbacks route through the shared pair controller, selecting fallback B swaps to primary B/fallback A, valid variants follow their models, primary variant selection routes through `pair.selectVariant`, direct `selection.set`/`selection.variant.set` is absent for composer primary selection, and the applicable paid/unpaid paths share the same authority (FR-001–FR-005, FR-017; SC-001–SC-002).

### User Story 3 - Ordered and failure-isolated actions (Priority: P1)

**Goal**: Prove the existing controller-local FIFO and deferred preference boundary at the real pair-operation seam.

**Independent test**: Hold operation 1 persistence pending, accept operation 2, inject failures and concurrent unrelated changes, then verify timing, exact authoritative rollback, preference deferral, and eventual convergence.

- [X] T002 [P] [US3] Add failing FIFO, failure-isolation, and preference-deferral coverage in `packages/app/test-browser/composer-model-pair.test.tsx`: assert operation 2 is admitted but does not read/mutate pair state or send a second request before operation 1 settles; assert only one request is active, operation 1 failure restores only its exact raw model/variant and fallback state, a concurrent agent change survives, fallback-only failure leaves primary state untouched, operation 2 starts from the restored/resulting state, failed operations do not commit recent/visibility/saved-variant effects, unrelated preference changes survive, and successful primary selection commits ordinary preferences after authoritative success (FR-008–FR-016; SC-003–SC-005, SC-008).

---

## Phase 2: User Story 1/2 implementation boundary

### User Story 1 - Consistent selection in both composer layouts (Priority: P1)

**Goal**: Expose only the smallest apply/commit separation needed by pair operations while preserving combined behavior for unrelated callers.

- [X] T003 [US1] Introduce the narrow authoritative-apply and post-success preference-commit primitives across `packages/app/src/context/models.tsx`, `packages/app/src/context/prompt-state.ts`, and `packages/app/src/context/local.tsx`: allow raw model/variant application without catalog side effects, provide the existing visibility/recent/saved-variant effects as an explicit commit path, and keep ordinary public setters composing both paths with their current behavior (FR-001, FR-003–FR-005, FR-014–FR-018; Constitution Principles II, III, V, X). Do not add a transaction object or global selection service.

### User Story 2 - Preserve valid variants across model changes (Priority: P1)

**Goal**: Ensure the new boundary preserves raw undefined/null/string distinctions and model-attached variant behavior.

The production boundary is implemented by T003; its variant-specific behavior is completed and checked by T007.

---

## Phase 3: User Story 3 implementation simplification

### User Story 3 - Ordered and failure-isolated actions (Priority: P1)

**Goal**: Remove incidental preference rollback reconstruction and make the existing controller persist, recover, and commit in strict FIFO order.

- [X] T004 [US3] Remove accidental preference rollback machinery from `packages/app/src/context/models.tsx`, `packages/app/src/context/local.tsx`, and `packages/app/src/pages/session/composer/prompt-model-selection.ts`: delete `models.selectionSnapshot()` and its recent/user/variant reconstruction, remove `affectedModels` plumbing used only by that rollback, remove local snapshot coupling to preference snapshots, and retain exact prompt/local raw model/variant restoration while preserving the local agent field and exact fallback-config distinctions (FR-012–FR-018; SC-008). Do not replace the removed code with a merge or reconstruction algorithm.

- [X] T005 [US3] Update the existing `ModelPairController` in `packages/app/src/pages/session/composer/prompt-model-selection.ts` to use the narrow authoritative apply path, exact operation-owned raw/fallback snapshots, and post-success preference commit: keep the controller-local promise-tail FIFO, compute each intent only at FIFO-head time, await `serverSync.updateConfig` and its existing refresh contract before settlement, restore only owned authoritative state on failure, notify through existing behavior, and let later actions continue from the settled/restored state (FR-008–FR-016, FR-019; SC-003–SC-005). Leave `packages/app/src/context/server-sync.tsx` unchanged except for direct type fallout.

---

## Phase 4: User Story 1/2 legacy layout convergence

### User Story 1 - Consistent selection in both composer layouts (Priority: P1)

**Goal**: Make the legacy composer consume the already-existing pair controller without changing layout or selector presentation.

- [X] T006 [US1] Wire the legacy model-control seam in `packages/app/src/components/prompt-input.tsx`, `packages/app/src/components/dialog-select-model.tsx`, and `packages/app/src/components/dialog-select-model-unpaid.tsx`: forward `pair.primaryModels` and `pair.selectPrimary` through `dialog-select-model.tsx` for paid legacy primary selection, and use the equivalent optional callback seam for unpaid legacy primary selection. Both selector paths retain direct-set fallback only for unrelated non-composer callers that do not provide the override. Route the legacy primary variant `Select.onSelect` to `pair.selectVariant`; preserve dialog closing, focus restoration, selector appearance, and current-layout ownership, and construct no second controller (FR-001, FR-002, FR-006, FR-007, FR-017; Constitution Principles I, III, VI).

### User Story 2 - Preserve valid variants across model changes (Priority: P1)

**Goal**: Confirm the legacy path exercises the same swap, variant carry/clear, null fallback variant, and hidden-fallback behavior as the current path.

- [X] T007 [US2] Complete integration/regression assertions in `packages/app/test-browser/composer-model-pair.test.tsx`, `packages/app/test-browser/prompt-input-model-pair.test.tsx`, `packages/app/test-browser/composer-model-commands.test.tsx`, `packages/app/test-browser/local-model-selection.test.tsx`, `packages/app/src/pages/session/composer/prompt-model-selection.test.ts`, and `packages/app/src/context/prompt-state.test.ts`: preserve normal, ID-less, and new-session pair reuse and hidden configured fallback coverage; verify old-layout swap/variant behavior, FIFO and failure isolation, successful preference commits, supported/unsupported/null variant rules, and exact raw snapshot behavior; adjust only assertions that explicitly freeze the removed preference-snapshot architecture (FR-001–FR-007, FR-008–FR-019; SC-001–SC-007). Preserve existing good coverage rather than rewriting it.

---

## Phase 5: Focused validation and scope checks

**Purpose**: Run the plan’s authoritative app, backend, and repository checks without mutating Git metadata.

- [X] T008 Run the exact focused validation commands below from `packages/app`, `packages/opencode`, and the repository root; record pass/fail results, run the Playwright smoke when environment support is available, report unchanged environment-specific FSEvents failures separately, and do not alter Git history or the index (SC-007–SC-008; Constitution Principle VIII).

  From `packages/app`:

  ```bash
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
  ```

  From `packages/opencode`:

  ```bash
  bun test \
    test/session/retry.test.ts \
    test/session/processor-effect.test.ts \
    test/session/prompt.test.ts
  ```

  From the repository root:

  ```bash
  git diff --check
  git diff --cached --check
  ```

---

## Dependencies and execution order

### Task dependencies

- T001 and T002 are independent test-first tasks and may run in parallel.
- T003 depends on T001 and T002 establishing the intended boundaries.
- T004 depends on T003 so removal leaves the narrow raw-apply/commit boundary intact.
- T005 depends on T003 and T004; it is the only controller implementation task.
- T006 depends on T005 so legacy callbacks target the final pair API.
- T007 depends on T005 and T006 and completes cross-layout/session regression coverage.
- T008 depends on T007 and is the completion gate.

### User-story completion order

- US1 and US3 test contracts start first.
- US1/US2 API separation precedes rollback deletion.
- US3 controller simplification precedes legacy US1/US2 wiring.
- US2/US3/US4 integration coverage is finalized after production paths converge.
- US4 is validated through the preserved normal, ID-less, new-session, and hidden-fallback coverage; it does not require a separate production abstraction.

### Parallel opportunities

- T001 and T002 can run in parallel because they touch separate test files and have no implementation dependency.
- Within T008, the app test invocations and backend test invocation are independent checks, but the final task should record all results together.

## Implementation strategy

### MVP scope

The smallest demonstrable increment is the legacy/current selection convergence: T001, T003, T004, T005, and T006, followed by the relevant US1/US2 assertions in T007. The feature is complete only after T002, the full integration coverage, and T008 pass or document unchanged environment-specific failures.

### Completion condition

The feature is done when the legacy and current layouts share the existing pair authority, pair persistence remains non-overlapping FIFO, failures restore only authoritative state, incidental preferences are committed only after success and never reconstructed on rollback, all required focused/regression checks pass, and the production diff contains less rollback machinery than the current tree.

## Notes

- Every task is implementation-ready, names concrete repository paths, and maps to the specified FR/SC or constitution constraint.
- No task creates a new controller, queue, transaction abstraction, revision/generation mechanism, global model-selection service, backend change, or Git metadata mutation.
- No generic setup, dependency installation, scaffolding, CI, documentation-polish, or unrelated cleanup task is included.

## Phase 6: Convergence

- [X] T009 Replace the hard-coded absolute `local.tsx` import in `packages/app/test-browser/local-model-selection.test.tsx` with a checkout-portable real-`LocalProvider` test boundary/module-isolation approach that preserves the boundary coverage and makes the required combined browser-test command pass without relying on Bun mock registration order per SC-007, Constitution VIII, and the plan's Validation Commands (partial)
