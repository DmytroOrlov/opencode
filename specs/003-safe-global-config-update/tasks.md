---
description: "Dependency-ordered implementation tasks for safe process-wide global configuration updates"
---

# Tasks: Safe Global Configuration Updates

**Input**: `specs/003-safe-global-config-update/spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/global-config-update.md`, and `quickstart.md`

**Scope**: Translate the locked architecture and product semantics into implementation tasks. Do not redesign the architecture. `/global/dispose` and frontend fallback-selector cleanup remain out of scope.

**Task format**: Every task uses `- [ ] Tnnn [P?] [USn?]` followed by one outcome, exact target paths, and prerequisite task IDs. `[P]` marks work that can proceed in parallel after its stated prerequisites.

## Phase A — GenerationGate foundation

**Purpose**: Establish FIFO shared/exclusive admission and the atomic reservation ownership lifecycle. No V1, V2, or config integration starts until the focused gate tests pass. The stable dependency-free gate Layer backs both `GenerationGate.node` and scoped process acquisition through the module `memoMap`.

- [X] T001 Add deterministic, test-first GenerationGate schedule tests in `packages/core/test/generation-gate.test.ts` for writer fairness, reader-after-writer blocking, multiple ordered writers, cancelled queued reader, cancelled queued writer, cancellation winning the grant/cancel race, grant winning with requester interruption before transfer and exactly-once lease release, and the following waiter proceeding after release. Use Deferred/latches and controlled hooks; use no sleeps. (Prerequisite: none)
- [X] T002 Implement the process-local FIFO shared/exclusive gate state and admission algorithm in `packages/core/src/session/generation-gate.ts`: contiguous reader-prefix admission, writer admission only at queue head after active readers drain, no post-writer reader overtaking, and FIFO writer order. Keep atomic state transitions short and never wait while holding the state mutation primitive. (Prerequisite: T001)
- [X] T003 Implement reservation ownership and lease lifecycle in `packages/core/src/session/generation-gate.ts`: atomic mutually exclusive `queued -> cancelled` or `queued -> granted(lease)`; cancellation-before-grant removes the waiter and reruns admission; grant-before-cancel cannot orphan ownership; interruption before transfer releases a reservation-owned lease exactly once; transfer makes it work-owned so requester cancellation cannot release it; release is idempotent and distinct from queued cancellation. (Prerequisite: T002)
- [X] T004 Expose the dependency-free process-global core `LayerNode`/service from `packages/core/src/session/generation-gate.ts` for reuse by both route graphs, without module-global mutable state or per-project gate construction. (Prerequisite: T003)
- [X] T005 Run and complete the focused deterministic gate suite in `packages/core/test/generation-gate.test.ts`; resolve failures in the gate implementation and tests before proceeding to Phase B. (Prerequisite: T001, T002, T003, T004)

**Gate**: T005 must pass before any later V1, V2, or global-config integration task begins.

## Phase B — One process-global gate identity with isolated listener graphs

**Purpose**: Prove both stable-layer sharing on a common memo map and process-wide sharing across isolated listener route memo maps. The old behavioral common-memoMap proof remains valid but is not sufficient by itself.

- [X] T006 Reopen Phase-B proof in the existing `packages/opencode/test/server/httpapi-config.test.ts`. Keep Proof A's behavioral reader/writer state-sharing assertion for consumers using one common memo map. Add Proof B: two acquisitions of the exact stable GenerationGate layer through the process memo map, each using a distinct live Scope, return the same concrete `GenerationGate.Interface` object; verify transferred reader A excludes writer B until release and writer then grants. Add Proof C: two separately fresh route/probe graph memo maps supplied the same gate replacement resolve/use that exact object while unrelated local layers are independently constructed. Make writer queue state deterministic with direct identity plus behavioral exclusion and a latch/yield only if required by the Effect seam; no sleeps. (Prerequisite: T005)
- [X] T007 Reopen listener/process wiring in `packages/opencode/src/server/server.ts`, `packages/opencode/src/server/routes/instance/httpapi/server.ts`, and the existing V1/V2/config consumers. In `startListener()`, acquire the exact stable process gate layer through the module `memoMap` using the listener Scope before building listener routes; make one `Layer.succeed(GenerationGate.Service, acquiredGate)` replacement; extend `HttpApiApp.createRoutes()` only as needed to apply it to both the main V1/global-handler branch and separately compiled SessionV2 branch. Build the ordinary route graph with its existing fresh `Layer.makeMemoMapUnsafe()`. Prove the two branches use the same acquired object. Keep listener Scope, HTTP/WebSocket/config/runtime resources and fresh `ConfigProvider` isolated. Do not share root memo maps, use `forkMemoMapUnsafe`, or introduce a mutable module singleton. (Prerequisite: T006)
- [X] T008 Skipped because the focused behavioral common-memoMap proof passed; the prescribed `createRoutes()` live-gate fallback is not required. (Conditional on proof failure)

**Gate**: Phase C and later integration cannot begin or proceed to T019 until reopened T006 and T007 are green. T008 remains the previously skipped conditional fallback and is not reinterpreted as this correction.

## Phase C — V2 coordinator ownership integration

**Story**: [US2] Preserve V2 generation paths and their ordering with config writers.

- [X] T009 Add test-first active-drain ownership cases in `packages/core/test/session-run-coordinator.test.ts`: newly admitted V2 work owns a shared lease through coordinator terminal/cleanup; joiners take no duplicate lease; success, failure, and interruption release once. (Prerequisite: T007 or T008)
- [X] T010 Integrate shared lease ownership with coordinator entries in `packages/core/src/session/run-coordinator.ts` and the V2 wiring in `packages/core/src/session/execution/local.ts`, preserving coordinator-owned work lifetime rather than wrapping `SessionExecution.resume()`. (Prerequisite: T009)
- [X] T011 Add test-first `pendingWake` ordering and ownership schedules in `packages/core/test/session-run-coordinator.test.ts`: wake-before-writer runs before it; writer-before-wake queues the successor behind it; queued interrupt cancels the reservation; granted-but-not-started interrupt releases the lease; active successor releases through normal coordinator lifecycle. Assert no writer starvation or leaked reader count. (Prerequisite: T010)
- [X] T012 Represent `pendingWake` as independently ordered future work in `packages/core/src/session/run-coordinator.ts` and `packages/core/src/session/execution/local.ts`, covering queued reservation, granted-but-not-started lease, and active successor-owned lease. On settle, release the current drain and start the successor only after its own reservation is granted and transferred. (Prerequisite: T011)
- [X] T013 Run the focused V2 coordinator suite in `packages/core/test/session-run-coordinator.test.ts` and verify active-drain and every `pendingWake` ordering/cancellation case, including no leaked reader count. (Prerequisite: T010, T012)

## Phase D — V1 Runner ownership integration

**Story**: [US2] Preserve V1 generation paths and their ordering with config writers.

- [X] T014 Add test-first V1 ownership cases in `packages/opencode/test/effect/runner.test.ts` for RunHandle and ShellHandle blocking a writer through cleanup, joiners avoiding duplicate leases, and pending ShellThenRun ordering before/after a writer. (Prerequisite: T013)
- [X] T015 Reopen focused V1 ownership coverage in the existing `packages/opencode/test/effect/runner.test.ts`: retain pending-work writer ordering/fresh Runner resolution and transferred RunHandle ownership cases; add deterministic cases for (1) reservation granted, then another RunHandle/pending work appears before commit, so the redundant admission is cancelled/released and existing work is joined; (2) shell start transfers admission, then Runner becomes Busy before ShellHandle commit, so transferred admission is released and Busy is preserved; and (3) cancellation after shell admission grant but before ShellHandle ownership leaves no lease leak and lets a waiting writer proceed. (Prerequisite: T014)
- [X] T016 Implement lease-aware Runner transitions in `packages/opencode/src/effect/runner.ts` for `Idle -> Running`, `Idle -> Shell`, and `Shell -> ShellThenRun`. Preserve joins for existing `Running` and `ShellThenRun`, preserve existing Busy behavior for Shell, and transfer ownership atomically to RunHandle/ShellHandle/PendingHandle. Never wait on GenerationGate while holding Runner's `SynchronizedRef` mutation. (Prerequisite: T015)
- [X] T017 Integrate admission and fresh per-directory InstanceState/Runner re-resolution at the V1 seam in `packages/opencode/src/session/run-state.ts`: after admission wait, atomically recheck; release a redundant lease and join work that appeared; otherwise transfer it to the owning handle. Pending ShellThenRun must retain queued, granted-but-not-transferred, and active RunHandle-owned states with cancellation behavior for each. (Prerequisite: T016)
- [X] T018 Reopen and run only the focused V1 Runner suite in `packages/opencode/test/effect/runner.test.ts`; verify the ownership edges added in T015 alongside existing cleanup-boundary release and pending-work ordering. Do not create `packages/opencode/test/session/run-state.test.ts`; keep the existing behavioral obligations in `runner.test.ts`. (Prerequisite: T015, T016, T017)

## Phase E — Atomic global-config persistence

**Story**: [US1] Apply changed settings without exposing partial configuration state.

- [X] T019 Add test-first persistence cases in `packages/opencode/test/config/config.test.ts` (or the established focused config suite): parse/decode failure, temp-write failure, and rename failure leave the old target intact; rename failure cleans the temp; successful rename commits; cache invalidation occurs only after commit; no-op behavior stays compatible. (Prerequisite: T006, T007, T015, T018)
- [X] T020 Harden only `Config.updateGlobal()` in `packages/opencode/src/config/config.ts` with the selected private atomic replacement flow: read/merge/parse/decode fully, create a unique same-directory temp, write complete serialized config, preserve required target metadata/mode supported by the platform API, rename as commit point, remove temp on pre-commit failure, and invalidate global config cache only after successful rename. Keep unrelated `Config.update()` writes unchanged. (Prerequisite: T019)
- [X] T021 Run the focused global-config persistence suite for `packages/opencode/src/config/config.ts` and verify pre-commit failures retain the old target, successful rename commits, cache invalidation follows commit, and no-op semantics remain compatible. (Prerequisite: T020)

## Phase F — Forward-only disposal hardening

**Story**: [US4] Recover consistently from cleanup failures after config commit.

- [X] T022 Add test-first cleanup cases in `packages/opencode/test/server/global-config-update.test.ts` or the established lifecycle suites for rejected and synchronously throwing disposers, multiple selected entries with one failing cleanup, non-reusability of every old selected entry, and protection of a newer identity-replaced entry. (Prerequisite: T021)
- [X] T023 Capture both synchronous callback throws and rejected promises as attributed cleanup outcomes in `packages/opencode/src/effect/instance-registry.ts` and `packages/opencode/src/server/global-lifecycle.ts`; attempt every selected callback, log cleanup defects, and continue cleanup without rolling back committed config. (Prerequisite: T022)
- [X] T024 In `packages/opencode/src/project/instance-store.ts`, snapshot/select globally invalidated entries, attempt each cleanup, then guarantee identity-checked eviction after each attempt even when a disposer/finalizer fails. Continue through remaining entries and never delete a newer replacement entry accidentally. (Prerequisite: T023)
- [X] T025 Run focused disposal/lifecycle tests in `packages/opencode/test/server/global-config-update.test.ts`, `packages/opencode/test/project/instance-store.test.ts`, and `packages/opencode/test/effect/instance-registry.test.ts` (use nearest existing suite paths if focused suites are colocated); verify every selected old entry is non-reusable after cleanup attempts. (Prerequisite: T023, T024)

## Phase G — `/global/config` exclusive application

**Story**: [US1] Keep the request pending until the exclusive update and required invalidation are consistent.

- [X] T026 Add deterministic handler cases in `packages/opencode/test/server/global-config-update.test.ts` for FIFO uncoalesced writers, changed response after eviction, no-op skipping disposal, cancellation before grant causing no mutation, and grant-before-HTTP-cancellation completing protected application. Preserve 400 validation and generic JSON 500 boundaries; assert no 409. (Prerequisite: T025)
- [X] T027 Replace the ordinary update path in `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` with exclusive GenerationGate ownership around `Config.updateGlobal()` and, when changed, awaited process-wide invalidation. Queue before any effective config read/merge/write; do not precompute an unlocked snapshot. Transfer a granted writer token to an uninterruptible protected application through consistency and release exactly once after completion/failure. Keep no-op disposal-free, remove ordinary `bridge.fork` and `swallowErrors: true`, preserve route validation/error behavior, and leave explicit `/global/dispose` unchanged. (Prerequisite: T026)
- [X] T028 Run the focused global config handler tests in `packages/opencode/test/server/global-config-update.test.ts`; verify success only after config and lifecycle consistency, request cancellation ownership boundaries, FIFO ordering, and unchanged explicit `/global/dispose` semantics. (Prerequisite: T027)

## Phase H — Cross-runtime deterministic integration coverage

**Story**: [US3] Prove admission/update ordering across both runtimes and process scope.

- [X] T029 Add one deterministic backend integration test in `packages/opencode/test/server/global-config-update.test.ts` using real production entry paths: admit a generation through the real Default/AppRuntime side, then send ordinary `/global/config` through real `Server.listen()`. Assert the config writer remains blocked, does not abort the active generation, the generation completes normally, and config application completes afterward. This also covers the historical fallback/global-config interruption regression; do not add a separate regression test if this exact behavior is proven here. Choose one generation runtime/path that reaches the real shared gate with the least test machinery, and coordinate with Deferred/latches at real ownership boundaries. (Prerequisite: T028)
- [X] T030 Skipped / not applicable: remove the originally planned simultaneous-two-listener integration case because repository production ownership supports one active `Server.listen()` lifecycle at a time; TUI replacement explicitly stops the prior listener before starting its replacement. Existing evidence covers the needed behavior: focused process acquisition with overlapping scopes proves memo-map observer/ref-count sharing; `httpapi-listen` lifecycle tests prove listener stop/restart behavior; T029 proves the real Default/AppRuntime ↔ listener production seam. No replacement integration test is needed. (Prerequisite: T029)
- [X] T031 Validation only: run exactly the surviving T029 Phase-H integration case. Confirm it uses real Default/AppRuntime and real `Server.listen()` paths, has no sleep/timing assertion, keeps the active generation un-aborted while config waits, applies config afterward, and covers the historical regression. T029 is the only new Phase-H integration test. Do not rerun focused suites or typecheck here; final regression/typecheck belongs exclusively to T032–T037. (Prerequisite: T030)

## Phase I — Final regression and validation

**Purpose**: Run the focused affected suites, repository typecheck, and final scope/invariant review after all implementation and integration tasks.

- [X] T032 [P] Run focused GenerationGate tests with `bun test packages/core/test/generation-gate.test.ts`. (Prerequisite: T031)
- [X] T033 [P] Run V2 coordinator tests with `bun test packages/core/test/session-run-coordinator.test.ts`. (Prerequisite: T031)
- [X] T034 [P] Run V1 Runner tests with `bun test packages/opencode/test/effect/runner.test.ts`. (Prerequisite: T031)
- [X] T035 [P] Run global config persistence, handler, disposal, and instance-store tests in their focused suites under `packages/opencode/test/config/`, `packages/opencode/test/server/`, `packages/opencode/test/project/`, and `packages/opencode/test/effect/`. (Prerequisite: T031)
- [X] T036 [P] Run directly adjacent suites affected by changed service/lease APIs across `packages/core/test/session/` and `packages/opencode/test/session/`, `packages/opencode/test/effect/`, and `packages/opencode/test/server/`. (Prerequisite: T031)
- [X] T037 Run repository typecheck with `bun run typecheck`. (Prerequisite: T032, T033, T034, T035, T036)
- [X] T038 Review/search the final diff and relevant paths to verify backend correctness does not depend on frontend `session_status`; no ordinary `/global/config` path forks disposal or writes effective global config before exclusive grant; no duplicate process-global GenerationGate is constructed; explicit `/global/dispose` semantics are unchanged; and frontend fallback-selector cleanup remains outside the feature. (Prerequisite: T037)
- [X] T039 Run `git diff --check` and resolve whitespace errors in the feature changes. (Prerequisite: T038)

## Dependency order and execution notes

The required critical chain is **T001 → T002 → T003 → T004 → T005 → (reopened T006 → reopened T007) → T009–T014 → reopened T015 → T016 → T017 → reopened T018 → T019–T021 → T022–T025 → T026–T028 → T029–T031 → T032–T039**. T019 cannot begin until reopened T006, T007, T015, and T018 are green. T008 remains skipped as the old conditional one-layer fallback; it is not the new listener injection design. Phase B proves common-map sharing, process acquisition across isolated map roots, and selective replacement in isolated route branches. Listener roots remain fresh, and only the gate service crosses the process boundary. Phases C–G then follow the mandatory sequence so persistence and cleanup are ready before handler success can be exposed. Phase H verifies the Default/AppRuntime-to-listener seam with one integration case; focused process acquisition and listener lifecycle suites prove scope/ref-count sharing and stop/restart behavior, while focused suites remain the proof for detailed ownership, ordering, cancellation, persistence, cleanup, and HTTP semantics.

### Parallel opportunities

- T032–T036 are independently runnable validation suites after T031; they are marked `[P]`.
- No implementation task is marked parallel because the phases intentionally share ownership seams and are dependency ordered. In particular, V1 and V2 integrations do not start before the reservation lifecycle and composition proof are complete.

### Independent test criteria by user story

- **US1**: A changed request stays pending through active work and process-wide eviction, commits atomically, and reports success only after consistent application; no-op skips disposal. Covered by T019–T021, T026–T029.
- **US2**: V1 and V2 work each retains admission through its actual cleanup boundary, including joiners and deferred follow-up work. Covered by T009–T018; T029 adds production-topology integration proof.
- **US3**: Deterministic focused schedules establish one process-wide gate identity/process scope, writer fairness, FIFO ordering, safe admission races, and ownership behavior; Phase H proves the Default/AppRuntime-to-listener shared gate and the historical backend regression. Covered by T001, T006–T008, T029–T031.
- **US4**: Validation, persistence, cancellation, grant-before-interruption ownership, disposal, and application failures produce explicit outcomes while cleanup proceeds forward and state is consistent before admission resumes. Covered by T001–T005, T009–T028; Phase H adds no separate shutdown or cancellation matrix.

### MVP scope

There is no independently shippable user-story MVP before the common gate and composition proof. The smallest safe increment is Phase A plus Phase B, followed by the V1/V2 ownership seams and atomic persistence, forward-only cleanup, and exclusive handler application. Stopping after a single runtime or before handler consistency would leave the specified safety contract incomplete.
