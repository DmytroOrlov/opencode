---
description: "Dependency-ordered implementation tasks for live fallback recovery"
---

# Tasks: Live Fallback Recovery

**Input**: Design documents from `specs/005-live-fallback-recovery/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `quickstart.md`

**Organization**: Tasks follow the locked implementation sequence in `plan.md`. Story labels map to the user stories in `spec.md`; foundational work has no story label.

**Execution rule**: Keep the GenerationGate, global config writer boundary, SessionRecovery, retryability, tool safety, and composer queue invariants unchanged. Do not add a fallback endpoint, do not implement a second recovery engine, do not add custom HTTP disconnect wiring or a server-side fallback-writer cancellation coordinator, do not coalesce ordinary `/global/config` writers, and do not reintroduce the falsified requirement that a client `AbortSignal` cancel a server reservation or queued writer.

## Phase A — Runtime-intent service

**Purpose**: Establish process-local latest fallback intent and make the same acquired service available to fresh listener graphs.

- [X] T001 Add deterministic service tests for absent override versus explicit `null`, raw fallback values, increasing revisions, latest-value wins, and stale `clearIfCurrent` no-op in `packages/opencode/test/session/fallback-runtime-intent.test.ts`.
- [X] T002 Implement `FallbackRuntimeIntent` and its stable `Layer`/`LayerNode`, `current()`, `stage(value)`, and `clearIfCurrent(revision)` operations in `packages/opencode/src/session/fallback-runtime-intent.ts`; acquire it with the process memoMap in `packages/opencode/src/server/server.ts` and selectively inject that exact instance into fresh graphs in `packages/opencode/src/server/routes/instance/httpapi/server.ts` (depends on T001).

## Phase B — Global-handler staging and reconciliation

**Purpose**: Expose only an owned fallback property before writer admission while preserving protected full-payload config application.

- [X] T003 [US4] Extend `packages/opencode/test/server/global-config-update.test.ts` with deterministic cases proving fallback-only early staging, mixed-payload isolation, B→C latest-intent preservation under stale cleanup, and runtime/persistence separation on persistence failure (depends on T002).
- [X] T004 [US4] Update `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` to own-property-check `fallback`, stage only that value before `reserveExclusive`, preserve the existing cancellable wait and post-transfer uninterruptible full-payload application sequence, and call `clearIfCurrent(stagedRevision)` on success, failure, or cancellation (depends on T003).

## Phase C — Fresh recovery resolution and post-backoff refresh

**Purpose**: Resolve intent at each recovery boundary and prevent a stale `retry_current` decision from authorizing another primary dispatch.

**Resume gate**: Do not start any task in this phase until the corrected T015 passes.

- [X] T005 [US1] Extend `packages/opencode/test/session/prompt.test.ts` and `packages/opencode/test/session/processor-effect.test.ts` to cover fresh runtime-over-persisted resolution, explicit clear, B→C latest choice, and a dispatched fallback target remaining frozen after later edits (depends on T002).
- [X] T006 [US1] Replace the captured `FallbackResolution` passed by `packages/opencode/src/session/prompt.ts` with a fresh effectful resolver consumed in `packages/opencode/src/session/processor.ts`; read runtime intent before persisted config and retain the existing resolution shape, provider lookup, same-model, already-used, model/variant availability, and fallback phase behavior (depends on T005).
- [X] T007 [US1] Add the **primary live-recovery regression** in `packages/opencode/test/session/processor-effect.test.ts` using controlled backoff/provider dispatch gates: with no fallback, fail primary attempt 1 retryably, stage B during backoff, and assert post-backoff recovery dispatches B exactly once, sends no primary attempt 2, and continues the same generation without a second prompt (depends on T006).
- [X] T008 [US1] Extend `packages/opencode/test/session/retry.test.ts` for the post-backoff refresh boundary, including refreshed `retry_current` permitting the next primary attempt, refreshed failover/terminal exiting the retry schedule for outer processor recovery, and abort during backoff preventing any later dispatch; implement the second fresh recovery check in `packages/opencode/src/session/retry.ts` and its callback path in `packages/opencode/src/session/processor.ts` without moving failover execution into SessionRetry (depends on T007).
- [X] T009 [US2] Retain the existing `SessionRecovery` replay/tool safety suite and add only any missing focused controls in `packages/opencode/test/session/processor-effect.test.ts` for configured fallback before generation and fresh same-model, unavailable-model, unavailable-variant, and already-used outcomes; do not duplicate broad recovery coverage (depends on T006).

## Phase D — Frontend direct-fallback supersession

**Purpose**: Let the latest direct fallback intent reach the server through the existing operation serializer, including when an older PATCH is pending.

**Resume gate**: Do not start any task in this phase until the corrected T015 passes. The frontend `AbortController` in these tasks is a local composer-queue release mechanism only; its success criterion is a promptly settled client promise so a newer PATCH can be transmitted, never a cancelled backend writer.

- [X] T010 [US3] Extend the `updateConfig` API in `packages/app/src/context/server-sync.tsx` with optional `{ signal?: AbortSignal }` and forward it to the existing generated config update request; keep callers omitting options unchanged and do not edit generated SDK files.
- [X] T011 [US3] Add deterministic deferred-persistence regressions F1–F6 in `packages/app/src/pages/session/composer/prompt-model-selection.test.ts`: B→C supersession, B→C→D stale-queue skip, model→variant supersession, explicit clear sending `{ fallback: null }`, genuine latest persistence failure rollback/notification, and ordinary swap/primary/pair ordering (depends on T010).
- [X] T012 [US3] Implement direct-intent invocation revisions, active persistence abort ownership, stale queued-operation skips before side effects, and supersession-aware persistence behavior for fallback-only operations in `packages/app/src/pages/session/composer/prompt-model-selection.ts`; retain the existing queue as the sole serializer and preserve ordinary standalone swap/primary/variant/cycle ordering (depends on T011).
- [X] T013 [US3] Add the explicit **F7 pair-routed supersession regression** in `packages/app/src/pages/session/composer/prompt-model-selection.test.ts`: direct `selectFallback(B)` routed through `swapInternal` remains owned by its originating fallback intent, aborts when cancellable, restores uncommitted pair state through the existing snapshot/restore seam, does not commit or notify, and allows C to PATCH and become the final pair/fallback state (depends on T012).
- [X] T014 [US3] Extend `packages/app/src/pages/session/composer/prompt-model-selection.ts` so direct fallback intents routed through `swapInternal` use the same abort/revision ownership and existing `persist` restore seam as fallback-only operations; keep superseded fallback-only state from rolling back over the newer intent, and keep a retained older server writer serialized so it may continue and complete in normal FIFO order after the local client request was superseded (depends on T013).

## Phase E — Cross-layer transport proof

**Purpose**: Prove the corrected cross-layer behavior over a real socket: a local client abort frees the caller, a newer request reaches the server, revisioned runtime intent supersedes live recovery immediately, the retained old server writer may safely finish, and durable FIFO ordering converges to the latest request. This phase runs immediately after Phase B and gates Phases C and D.

**Note**: The previously planned proof (`client AbortSignal` → HTTP disconnect → server request interruption → `reservation.await` interruption → queued writer cancellation) was falsified by a real `Server.listen()` test and a Bun + node:http transport diagnostic (recorded in `research.md`). The old requirement is removed everywhere and must not be reintroduced.

- [X] T015 [US4] Add the **corrected real HTTP B-abort → C-arrival → runtime-latest → FIFO convergence proof** to the real-listener section of `packages/opencode/test/server/global-config-update.test.ts`, using real `Server.listen()`, real `fetch()`, and a real `AbortController` with shared `GenerationGate` admission held: (1) send PATCH fallback B through `fetch(..., { signal })`; (2) before abort prove runtime B staged, writer B queued pre-transfer, transfer count zero, and persisted fallback unchanged; (3) abort the client fetch and prove the client promise rejects promptly, without requiring writer B to disappear — B remains pre-transfer and persistence remains blocked while shared admission is held; (4) while B is still server-side queued, send a real PATCH C; (5) before releasing shared admission prove runtime intent is C at a newer revision, writer C is queued, persisted fallback is still the original value, and B has not transferred; (6) release shared admission and allow normal writer ordering to proceed; (7) prove stale completion/cleanup of B does not clear runtime C, C eventually persists, the runtime override clears after C completes, the final persisted fallback is C, and no lease/token leak remains (a later writer still reserves, transfers, and releases). Do not add artificial waits asserting that B is cancelled server-side (depends on T004; gates T005–T014 and T016).

## Phase F — Focused validation and hygiene

**Purpose**: Run the focused package checks after implementation and record any environment limitation accurately.

- [X] T016 Run focused backend tests for `packages/opencode/test/session/fallback-runtime-intent.test.ts`, `packages/opencode/test/session/retry.test.ts`, `packages/opencode/test/session/prompt.test.ts`, `packages/opencode/test/session/processor-effect.test.ts`, and `packages/opencode/test/server/global-config-update.test.ts`; run `bun run typecheck` from `packages/opencode` and `packages/core`, then run the frontend suite `bun test --conditions=solid --preload ./happydom.ts ./src/pages/session/composer/prompt-model-selection.test.ts` and `bun run typecheck` from `packages/app`; finish with `git diff --check` and `git diff --cached --check`. Use `packages/opencode/test/server/httpapi-global.test.ts` only if route-level request coverage is added; report any known macOS Bun/FSEvents startup failure as an infrastructure limitation rather than a product failure.

## Dependencies and execution order

### Phase dependencies

- **Phase A**: T001 → T002 *(complete)*. The runtime-intent state and process identity are prerequisites for handler and recovery work.
- **Phase B**: T002 → T003 → T004 *(complete)*. Handler staging depends on the shared process service and is covered before implementation.
- **Phase E**: T004 → T015. The corrected T015 executes first, right after T004, and is the **resume gate for the rest of the feature**: no Phase C or Phase D task may start until T015 passes.
- **Phase C**: T015 → T002 → T005 → T006 → T007 → T008. T009 depends on T006 and T015 and protects existing recovery outcomes; it can proceed independently of T007/T008 once T006 is complete.
- **Phase D**: T015 → T010 → T011 → T012 → T013 → T014. The app transport option precedes the deterministic controller cases; implementation follows those ownership-boundary regressions.
- **Phase F**: T016 follows all implementation and regression tasks, including the corrected T015.

### Primary regression dependency path

T001 → T002 → T003 → T004 → **T015** → T005 → T006 → T007 → T008. T015 is the resume gate for implementation; T007 is the primary product gate: fallback B staged during controlled retry backoff must be selected before another primary dispatch, with exactly one fallback attempt in the same generation.

### Parallel opportunities

- After the corrected T015 passes, Phase C resolution work (T005–T009) and Phase D frontend work (T010–T014) touch separate packages and can proceed in parallel; implementation remains gated by each suite's tests.
- After T010, frontend controller coverage (T011) is independent of backend retry work.
- Nothing runs before T015: it is the only task allowed between the completed T004 and the resumption of implementation.
- Do not parallelize changes to the same test/controller file or bypass the dependency order within a phase.

## Independent test criteria by user story

- **US1 — active retry uses newly selected fallback**: T007 demonstrates same-generation B dispatch after selection during backoff, no primary attempt 2, and no second prompt.
- **US2 — existing fallback and recovery safety remain intact**: T005/T009 retain configured-fallback-first behavior, dispatch freeze, and existing restart/continue/terminal safety outcomes without broad suite duplication.
- **US3 — latest intent wins until dispatch**: T005 covers backend B→C/clear and frozen accepted dispatch; T011–T014 cover frontend F1–F7 and stale queued work.
- **US4 — safe global config application**: T003/T004 keep mixed unrelated fields and destructive work behind writer admission; T015 verifies the corrected real HTTP proof — local abort frees the caller, a newer request reaches the server, revisioned runtime intent supersedes live recovery immediately, the retained old server writer may finish, and durable FIFO ordering converges to the latest request.

## Implementation strategy

The locked ordering is: T001–T004 complete; the corrected T015 is the immediate resume gate; then T005–T009 recovery work; then T010–T014 frontend supersession; then T016 focused validation. No task requires reopening architecture; the plan is locked and supplies the implementation boundaries.
