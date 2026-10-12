# Tasks: Prompt Async Scope Lifetime

**Input**: Design documents from `/specs/004-prompt-async-scope-lifetime/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, and `contracts/prompt-async.md`

**Scope**: One existing primary RED, one new writer-held real-HTTP regression, the minimal handler scope fix, and focused validation. Do not add research, redesign, or fallback tasks.

## Phase 1: Record Existing Regression Evidence

**Purpose**: Capture the already-known free-gate HTTP failure before production changes.

- [X] T001 [US1] Run `cd packages/opencode && bun run script/httpapi-exercise.ts --mode effect --include prompt_async` before production changes and record that the request returns 204, never reaches the fake LLM, and times out.

## Phase 2: Writer-Held HTTP Regression

**Purpose**: Add exactly one deterministic test for admission while an exclusive GenerationGate lease is held.

**Independent Test**: With the writer lease held, POST `/prompt_async` returns 204, the background child reaches shared admission, and the fake LLM has not started; after releasing the lease, that same accepted prompt completes exactly one generation and assistant without reposting.

- [X] T002 [US2] Add the single writer-held real-HTTP `/prompt_async` regression to `packages/opencode/test/server/httpapi-session.test.ts`, using the injectable GenerationGate and existing Queue/Deferred/fake-LLM seams; assert acceptance, shared admission, no early LLM start, and exactly one completed generation after releasing the writer.
- [X] T003 [US2] Run the focused case in `packages/opencode/test/server/httpapi-session.test.ts` before the production change and record that the writer-held regression fails deterministically without sleeps.

## Phase 3: Minimal Production Fix

**Purpose**: Give the accepted background prompt an operation-local resource scope while retaining the handler scope as its supervisor.

- [X] T004 [US1] In `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`, add `Effect.scoped` to the `promptSvc.prompt(...).pipe(Effect.catchCause(...))` operation before `Effect.forkIn(scope, { startImmediately: true })`, following local formatting. If this exact fix does not turn the established primary RED green, stop and report the contradiction without a fallback redesign.

## Phase 4: Verify Regressions

**Purpose**: Confirm both regressions pass with the minimal scope fix.

- [ ] T005 [P] [US1] Re-run `cd packages/opencode && bun run script/httpapi-exercise.ts --mode effect --include prompt_async` and confirm the accepted free-gate prompt reaches the fake LLM and completes exactly one assistant result.
  - **BLOCKED — infrastructure / FSEvents**: The established attempt fails with `Error starting FSEvents stream` before scenario execution. Not product RED; left unchecked.
- [X] T006 [P] [US2] Re-run the writer-held case in `packages/opencode/test/server/httpapi-session.test.ts` and confirm it passes through lease release with exactly one generation and assistant.

## Phase 5: Focused Validation and Stop

**Purpose**: Reuse neighboring coverage, then run the existing HTTP API target, typecheck, and diff hygiene; stop afterward.

- [X] T007 [US1] Run neighboring coverage from `packages/opencode`: `bun test test/server/httpapi-promptasync-context.test.ts test/effect/runner.test.ts test/server/global-config-update.test.ts ../core/test/generation-gate.test.ts`.
- [X] T008 Run typecheck from `packages/opencode` and diff hygiene from the repository root. The `bun run test:httpapi` sub-check was attempted once and is recorded below.
  - **BLOCKED — infrastructure / FSEvents**: `bun run test:httpapi` passed coverage mode (208/208), then exited during auth-mode startup with `Error starting FSEvents stream`, before auth scenarios executed. HTTP API sub-check is blocked, not product RED.

## Dependencies & Execution Order

- T001 establishes the existing primary RED and must precede all production changes.
- T002 depends on T001; T003 depends on T002 and must establish its RED before T004.
- T004 depends on T003.
- T005 and T006 depend on T004 and can run in parallel.
- T007 follows the regression checks; T008 follows T007 and is the final task.
- Stop after T008. Do not proceed to `/implement` from task generation.

## Parallel Opportunities

After T004, T005 and T006 validate separate regression paths and may run in parallel. The remaining validation is sequential as listed.

## Implementation Strategy

Execute in order: record the existing primary RED; add and establish the sole writer-held RED; apply the one handler scope change; confirm both regressions GREEN; run focused neighboring coverage and final validation; stop.

The sole expected production change is `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`. No other production files are in scope.
