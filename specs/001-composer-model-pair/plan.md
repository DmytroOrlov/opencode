# Implementation Plan: Consistent Composer Model-Pair Persistence

Branch: 001-composer-model-pair
Date: 2026-09-21
Spec: specs/001-composer-model-pair/spec.md

## Summary

Wire the legacy PromptInput model controls to the already-authoritative
ModelPairController, then simplify pair-operation rollback so only authoritative
primary/variant state and the exact fallback config are transactionally recoverable.
The existing controller-local promise tail remains the FIFO; no new queue, revision
IDs, transaction framework, or global selection service is introduced.

The production change is intentionally concentrated in the legacy selector seam,
the unpaid selector callback seam, the pair controller, and the two model-selection
implementations that must expose a narrow authoritative-apply/preference-commit
boundary. Existing current-layout wiring and server refresh behavior remain intact.

## Technical Context

Language/Version: TypeScript, SolidJS, Bun-managed monorepo

Primary Dependencies: Solid stores/transitions, TanStack Solid Query, existing
ModelPairController, app server-sync context, Bun test, Playwright browser tests

Storage: Browser-persisted prompt/local model state and global model catalog
preferences; server-persisted global fallback config

Testing: Bun unit/browser tests, Playwright composer tests, app tsgo typecheck,
focused packages/opencode Bun tests, root diff checks

Target Platform: OpenCode web/desktop app composer in current and legacy layouts

Project Type: TypeScript desktop/web application with a local OpenCode backend

Performance Goals: Preserve current composer responsiveness; accepted actions may
enqueue immediately, but pair mutation and fallback persistence have at most one
active operation and no additional coordination layer.

Constraints: Strict controller-local FIFO; later actions must not compute, mutate
pair state, or send persistence until the prior operation fully settles, including
required server refresh. Preserve raw undefined/null/string distinctions where
they are part of authoritative state. Do not change layout, backend policy,
telemetry, TLS, routing, generated SDK, or unrelated selectors.

Scale/Scope: One composer model-pair controller and its current/legacy UI consumers;
normal, ID-less, and new-session flows; focused app and backend regression coverage.

## Constitution Check

GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.

Passes before research:

- Principle I: preserve existing model-pair semantics, fallback exposure, error
  notification, layout, and successful preference behavior; only the specified
  legacy bypass and failure boundary change.
- Principles II and VI: reuse the existing ModelPairController; the legacy UI only
  translates selector callbacks and creates no controller.
- Principle III: all active-composer primary/fallback/variant mutations converge on
  the pair controller. Non-composer selection callers retain the existing combined
  setter behavior.
- Principle IV: retain the existing controller-local promise tail and make its
  operation body settle authoritative persistence/recovery before the next item.
- Principles V and X: remove broad model-catalog preference snapshots and defer
  recent, visibility, and saved-variant writes until authoritative success.
- Principle VII: production scope is limited to the listed composer/context files;
  no backend, TLS, telemetry, routing, generated SDK, or unrelated selector work.
- Principle VIII: validation uses existing app Bun/Playwright/typecheck and required
  backend/root checks.

No constitution exception or complexity-tracking entry is required.

## Project Structure

### Documentation

specs/001-composer-model-pair/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks.md                 # created later by speckit-tasks; not created here

No contracts directory is needed: this is an internal UI/controller change with no
new external API, endpoint, or file format.

### Source and tests

packages/app/src/components/prompt-input.tsx
packages/app/src/components/dialog-select-model.tsx
packages/app/src/components/dialog-select-model-unpaid.tsx
packages/app/src/pages/session/composer/prompt-model-selection.ts
packages/app/src/context/local.tsx
packages/app/src/context/models.tsx
packages/app/src/context/prompt-state.ts
packages/app/src/context/server-sync.tsx       # retained; refresh is validation-critical
packages/app/src/components/prompt-input/contracts.ts       # retained contract
packages/app/src/components/prompt-input-v2.tsx              # retained current path
packages/app/src/pages/session/composer/session-composer-controls.ts # retained owner wiring
packages/app/src/pages/session/use-composer-commands.tsx     # retained command wiring

packages/app/src/pages/session/composer/prompt-model-selection.test.ts
packages/app/src/context/prompt-state.test.ts
packages/app/test-browser/composer-model-pair.test.tsx
packages/app/test-browser/composer-model-commands.test.tsx
packages/app/test-browser/local-model-selection.test.tsx
packages/app/test-browser/prompt-input-model-pair.test.tsx    # focused legacy seam
packages/app/e2e/user-story/model-selection-flow.spec.ts       # existing smoke path

packages/opencode/test/session/retry.test.ts
packages/opencode/test/session/processor-effect.test.ts
packages/opencode/test/session/prompt.test.ts

Structure decision: Keep ownership in packages/app/src/pages/session/composer,
expose it through the existing PromptInputControls contract, and test the UI seams
under packages/app/test-browser plus the existing Playwright user-story suite.

## Implementation Design

### Legacy layout wiring

createPromptInputController already supplies model.pair and reuses an injected pair
when one exists. PromptInput should consume that field directly:

1. Pass pair.primaryModels and pair.selectPrimary to the paid
   ModelSelectorPopover through dialog-select-model.tsx, where the legacy paid
   selector accepts and forwards `items={pair.primaryModels}` and
   `onSelect={pair.selectPrimary}` to the model list. When the composer supplies
   `onSelect`, selecting a model invokes that callback instead of directly
   calling `selection.set`; callers without the override retain the existing
   direct-selection fallback.
2. Extend DialogSelectModelUnpaid with an optional primary-selection callback and
   pass pair.selectPrimary from PromptInput. The dialog keeps its current direct
   setter fallback for non-composer callers.
3. Route the legacy variant Select.onSelect to pair.selectVariant.

The callbacks still close the existing dialog/popover and restore focus as today;
only mutation ownership changes. No selector markup, styling, layout, or new
controller is introduced in the dialog or selectors. PromptInputV2, session-composer-controls, and
use-composer-commands remain the current-layout ownership proof and are not
rewritten.

### Pair operation phases and ownership

Retain the current tail.then(() => operation(intent)) plus
tail = result.catch(() => {}) pattern. The operation must read primary, displayed
fallback, model metadata, and current raw variant only when it reaches the FIFO
head. It then computes the transition and captures only the exact authoritative
state it may own:

- primary raw model presence/value and raw variant presence/value;
- exact pre-operation fallback config, including absent/null/variant distinctions,
  whenever fallback config is changed optimistically.

The narrow ModelSelection API should separate authoritative application from
incidental catalog effects. Use repository-consistent names, but the behavior is:

- an apply primitive updates only raw local/prompt model and variant state;
- a commit primitive performs existing visibility/recent/saved-variant effects for
  the accepted primary model after authoritative success;
- existing public selection setters remain combined for non-pair callers by
  composing the same primitives.

If existing lower-level write/prompt.model.set primitives can be exposed without a
broader abstraction, use that smallest API rather than a generic transaction object.

For each operation at FIFO head:

1. Read current authoritative pair state.
2. Compute the model/fallback/variant transition with existing fallback helpers.
3. Capture the raw selection snapshot and/or exact fallback config required for
   recovery.
4. Apply only the optimistic authoritative selection/config mutation needed for
   immediate composer state.
5. Await serverSync.updateConfig when fallback config changes; its existing
   onSuccess refresh remains awaited by the mutation promise.
6. On failure, restore only captured raw selection fields and/or exact fallback
   config owned by this operation, then notify using existing behavior. Never
   restore agent state or model-catalog preferences.
7. On success, commit only preference effects appropriate to the accepted primary
   and variant choice.
8. Await required apply/commit completion and let the existing tail admit the next
   action.

Fallback-only operations capture and restore fallback config only; they do not touch
primary model or primary variant state. Primary-changing failures restore exact raw
model/variant state while preserving concurrent agent changes.

### Rollback simplification

- Retain prompt-state.ts raw model snapshot semantics, including absent and
  explicit undefined, null, and string variant presence/value.
- Narrow local.model.snapshot() to restore only local authoritative model and
  variant fields in the current session/draft record, preserving its agent field.
  Remove its preference snapshot call and bookkeeping that existed only to
  coordinate preference restoration.
- Remove models.selectionSnapshot() and its recent/user/variant reconstruction
  algorithm from models.tsx.
- Remove affectedModels plumbing from pair persistence and selection snapshots.
- Keep server-sync.tsx unchanged: required config update and bootstrap/provider
  refresh completion is part of the FIFO settling contract.

Preference classification is recorded in research.md and data-model.md:
recent insertion, visibility promotion, and saved per-model variant entries are
incidental-after-success; active prompt/local model and variant plus fallback config
are authoritative; agent selection is unrelated and never owned by pair rollback.

## Test Plan

Update focused tests to verify the final contract rather than the removed
preference rollback algorithm:

- Legacy boundary: render/use the real PromptInput model-control seam with primary
  A and fallback B, select B through paid and unpaid selector callback paths, and
  assert the pair controller receives the action while direct selection.set is not
  called. Resolve the operation and assert primary B, fallback A, and
  model-attached variants. Exercise the legacy primary variant control and assert
  it calls the pair controller.
- Current command/current-layout proof: retain composer-model-commands.test.tsx
  and current V2 assertions that the same pair instance handles command and
  selector actions, including hidden configured fallback augmentation.
- FIFO: hold the first real pair persistence pending, accept a second action, and
  assert before resolution that the second action has not changed pair state and no
  second request exists. Reject/resolve the first operation, then assert the
  second computes from settled/restored state and starts exactly one second request.
- Failure isolation: verify exact raw primary model/variant restoration with a
  concurrent agent update; verify fallback-only failure leaves primary model and
  variant unchanged.
- Preference isolation: mutate unrelated recent/visibility/saved-variant state
  while pair persistence is pending; after failure, assert it remains present and
  no broad reconstruction runs. Assert failed pair-owned preference effects were
  not committed before success.
- Successful preference commit: assert ordinary primary selection still promotes
  visibility, pushes recent, and saves selected variant only after authoritative
  success. Preserve null fallback variant behavior and hidden fallback selection.
- Keep existing pure transition, prompt raw snapshot, command-routing,
  normal/no-ID/new-session reuse, and backend recovery tests unless an assertion
  specifically freezes the deleted preference snapshot behavior; update only such
  assertions to the new contract.

## Validation Commands

From packages/app:

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

From packages/opencode:

    bun test \
      test/session/retry.test.ts \
      test/session/processor-effect.test.ts \
      test/session/prompt.test.ts

From repository root:

    git diff --check
    git diff --cached --check

Known environment-specific FSEvents failures must be reported separately from
composer regressions if unchanged. No Git history or index mutation is part of this
feature plan.

## Complexity Tracking

No violations. The plan deletes the global preference snapshot/rollback layer and
reuses the existing controller-local FIFO rather than adding coordination
infrastructure.
