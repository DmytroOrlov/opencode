# Implementation Plan: Safe Global Configuration Updates

**Branch**: `003-safe-global-config-update` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-safe-global-config-update/spec.md` and its completed requirements checklist.

## Summary

Add one process-wide, writer-fair `GenerationGate` in `packages/core`. V1 runs, V2 coordinator-owned drains, their separately ordered follow-up work, and ordinary changed `/global/config` applications all use that same gate. Generation work holds shared leases through real terminal cleanup. A config request reserves FIFO exclusive admission before reading or mutating configuration, atomically replaces the config file, and then performs forward-only cache and instance invalidation before releasing the writer. Queued reservations are interruptible and removable; once destructive application begins, client cancellation cannot interrupt it.

## Technical Context

**Language/Version**: TypeScript, repository-pinned Bun runtime.

**Primary Dependencies**: Effect, `@effect/platform` FileSystem, repository `LayerNode` / `AppNodeBuilderV1` composition.

**Storage**: Global config file; process-local loaded `InstanceStore` cache.

**Testing**: Vitest repository tests, using Effect `Deferred`/latches for deterministic concurrency schedules; no sleeps for gate-order proofs.

**Target Platform**: OpenCode server process on supported Bun platforms.

**Project Type**: TypeScript monorepo library and server.

**Performance Goals**: Gate state transitions remain short and synchronous; no lock is held while a waiter awaits. No polling. Existing concurrent generation readers remain batch-admissible when FIFO ordering permits.

**Constraints**: One gate identity across separate V1 and SessionV2 graphs; writer fairness; same-directory atomic config replacement; preserve `/global/dispose` behavior; preserve existing 400 and generic JSON 500 boundaries; no coalescing of writes; no module-global mutable singleton; no frontend activity state in correctness decisions.

**Scale/Scope**: One effective in-memory gate across the process, observed through the stable gate layer and the process memo map. Listener route graphs retain their own fresh root memo maps and listener-owned scopes/resources; only the GenerationGate service is selectively injected into them. No durable queue or cross-process coordination.

## Constitution Check

Applicable principles are the repository's minimal, evidence-driven change and deterministic validation requirements. The active telemetry constitution is domain-specific; this feature does not alter telemetry semantics, providers, attempt ownership, or UI behavior. The design extends existing Effect coordination, service composition, config, and instance lifecycle boundaries and stays within the active specification.

| Gate | Result | Evidence / plan |
|---|---|---|
| Reuse existing coordination and lifecycle ownership | PASS | Use Effect state primitives, V1 `Runner`, V2 `SessionRunCoordinator`, existing config handler and `InstanceStore`; add only the missing shared gate. |
| Keep scope minimal and evidence-driven | PASS | Limit persistence hardening to `Config.updateGlobal`; do not redesign `Config.update`, `/global/dispose`, or frontend fallback guard. |
| Preserve correctness across async lifecycle and cleanup | PASS | Leases transfer to actual run handles/drains; reservations retain follow-up ordering; writer owns mutation through invalidation. |
| Deterministic tests define concurrency behavior | PASS | Deferred/latch-driven gate and narrow integration schedules are specified in [quickstart.md](quickstart.md). |

No constitution violation requires an exception.

## Design

### Gate state machine and admission algorithm

The new `packages/core/src/session/generation-gate.ts` service owns `activeReaders`, `exclusiveActive`, and an ordered FIFO queue of reader and writer reservations. An atomic `SynchronizedRef` transition enqueues and grants; a `Deferred` represents each grant. State transitions never await while holding the synchronized mutation. Whenever no writer is active, admission grants the contiguous reader prefix at the FIFO head, including readers queued ahead of a later writer even while older readers remain active. It grants an exclusive writer only when that writer is the queue head and `activeReaders` is zero. A writer at the head blocks later readers until all current readers drain. Releasing ownership reruns this head algorithm. A queued cancellation removes that exact waiter atomically and reruns admission immediately. A granted shared lease has idempotent release.

Shared reservations establish order immediately and can be awaited later. Reservation outcome is one atomic, mutually exclusive transition: `queued -> cancelled` or `queued -> granted(lease)`. Cancellation while queued removes the waiter, reruns queue-head admission, and creates no lease. If grant wins, cancellation cannot report that the waiter was removed. The granted lease first has explicit `reservation-owned` status; one atomic transfer changes it to `work-owned`, and release changes the owner to `released`. If interruption occurs after grant but before transfer, the reservation finalizer claims and releases that lease exactly once. If transfer wins, requester cancellation cannot release it; only the owning work's terminal finalizer can. Idempotent release remains defensive against repeated finalization, while the ownership transition prevents competing finalizers from both claiming release.

Exclusive reservations use the same atomic outcome and ownership transfer. Cancellation before grant removes the queued writer and causes no config mutation. If exclusive grant wins, ownership transfers directly to the protected config application, which continues uninterruptibly through the consistency boundary after client disconnect. There is no granted-but-abandoned writer state.

### Process-global service identity

Expose a dependency-free global `LayerNode` from the core session module, backed by one exact stable `Layer` object. Add a scoped process-acquisition API that builds that layer against the existing module `memoMap`, using the caller-supplied `Scope`, and returns `GenerationGate.Service`. This stable layer remains the backing for `GenerationGate.node`; do not add a raw module-global service/interface variable, mutable queue singleton, or separate registry.

The module `memoMap` deduplicates that layer only for graphs built with that map. `Server.Default()` / `HttpApiApp.webHandler()` use the module map, while each `Server.listen()` creates its own listener scope and fresh root memo map. Keep this listener lifetime boundary intact. Before building a listener route graph, `startListener()` acquires the process gate using that listener scope, creates one `Layer.succeed(GenerationGate.Service, acquiredGate)` replacement, then builds the route graph using its existing fresh memo map. Extend `HttpApiApp.createRoutes()` only enough to accept this replacement and apply it in every branch that otherwise compiles `GenerationGate.node`: the main app graph containing V1 `SessionRunState` and the `globalHandlers` environment, and the separately compiled `SessionV2.node` graph containing `SessionExecutionLocal.node`. Both branches receive the exact same acquired service object.

Do not share the listener root memo map with the process map or use `Layer.forkMemoMapUnsafe(processMemoMap)`: either can expose unrelated process or listener services across lifetime boundaries. Default/AppRuntime graphs continue to compile the normal stable node on the module map. Each live Default/AppRuntime/listener observer contributes a scoped layer observer; listeners reuse the same gate while overlapping, and stopping one listener drops only its observer. It cannot dispose/recreate the gate while another observer remains live. If all observers disappear and no process work is active, a later acquisition may create a new empty gate; queue state is not durable. Acquire the listener observer before building listener-owned layers/resources so scope finalization tears those resources down before dropping the gate observer.

### V2 ownership and follow-up work

`SessionRunCoordinator` owns the V2 work. A new idle coordinator entry establishes a shared reservation before its drain crosses into execution; after admission, the coordinator-owned drain holds the lease until its terminal/cleanup path completes. Callers joining an active execution only join its `done` and do not reserve a second reader.

`pendingWake` represents new future work, so it gets a distinct reservation when `wake()` records it, not when `settle()` later starts the successor. Store the explicit ownership state with the pending follow-up: queued reservation or granted-but-not-started shared lease. This preserves ordering against queued config writers. On settle, release the current drain lease and allow a successor only after its own reservation is granted and ownership transferred to its coordinator entry. If `interrupt()` occurs before successor start, cancel/remove a queued reservation or release a granted-but-not-started lease. An active successor retains coordinator ownership and releases through its normal terminal lifecycle. Wake-before-writer / writer-before-wake ordering remains unchanged.

### V1 state-transition integration

Do not gate the whole `SessionRunState.ensureRunning()` request. `SessionRunState` resolves the per-directory `Runner`; the `Runner` owns actual Running, Shell, and pending transitions. Add lease-aware Runner APIs so checking/joining and ownership transfer remain atomic with Runner state updates, without waiting on the global gate under `SynchronizedRef` mutation.

An already Running caller joins the existing `done`; an existing ShellThenRun caller joins its pending `done`. Neither creates new work or another reservation. An Idle-to-Running request reserves shared admission, waits, then re-resolves current `InstanceState` and Runner and atomically rechecks state. If another run appeared, release the redundant lease and join it; otherwise transfer the lease to the new RunHandle. Idle-to-Shell follows the same pattern and preserves Busy when a shell/run appears while waiting. The owning RunHandle or ShellHandle releases its lease at real terminal cleanup/cancellation.

Shell-to-ShellThenRun creates new future work. Reserve it at request ordering time. If it is queued ahead of a writer, its granted lease can remain admitted through the shell-to-run handoff and hold that writer. If the writer precedes it, wait behind the writer and re-resolve fresh InstanceState/Runner before committing the pending transition. PendingHandle carries explicit ownership: queued admission is cancelled/removed on cancellation; granted but not yet transferred admission releases its lease; after atomic transfer, the active RunHandle owns release and cancellation of the original requester cannot release it. Existing ShellThenRun joiners create no duplicate reservation. `prompt.ts` requires no semantic change if this seam remains authoritative.

### Global configuration critical section and persistence

Every `/global/config` mutation reserves the same exclusive FIFO gate before `Config.updateGlobal()` reads, merges, parses, or writes. Do not precompute a merged patch from an unlocked config snapshot and do not coalesce requests. Each writer runs against the preceding writer's committed result. A serialized no-op returns without process-wide disposal.

For changed config, fully parse/merge/decode before touching the target. Write complete content to a unique temporary file in the same directory, preserve appropriate existing target metadata/permissions where the platform abstraction requires it, then use `FileSystem.rename(oldPath, newPath)` as the commit point. Remove the temp on any pre-commit failure. Invalidate the config cache only after successful replacement. Before rename, failure leaves prior config effective and follows the existing server error path. Do not extend this private atomic flow to unrelated `Config.update()` persistence.

After commit, the sequence is forward-only: new config is authoritative, invalidate the config cache, evict/invalidate every previously loaded instance, then release exclusive admission. Run this protected sequence uninterruptibly with respect to request disconnect/cancellation. Do not use `bridge.fork` or `swallowErrors: true` for this ordinary changed request. The explicit `/global/dispose` remains unchanged.

### Forward cleanup and failure boundary

Harden disposer invocation so synchronous throws and rejected promises are both captured as settled cleanup outcomes, and attempt every registered disposer. For every InstanceStore entry selected at global-disposal start, wait for its load outcome, attempt disposal, and evict the matching cache entry in guaranteed cleanup even when a disposer fails. Continue through remaining entries and log attributed defects. New loads must not reuse any pre-commit cached entry. Resource cleanup rejection does not justify rolling the config back.

Successful consistency means committed new config, invalidated config cache, no reusable pre-application InstanceStore entries, and a cleanup attempt for each selected entry. If resource cleanup reports defects but this state is established, log them and complete the forward transition. With the current `Map` cache and synchronous identity-checked deletion, inability to establish eviction is not representable as an ordinary typed Effect failure; disposer failures are catchable and deletion itself has no typed failure channel. Only a process/runtime defect outside that typed cleanup flow could prevent the invariant. Do not invent a recovery API. If implementation reveals a new fallible eviction boundary, retain exclusive ownership through server recovery/termination whenever it cannot prove eviction.

### HTTP and interruption behavior

Queued config writer waits are interruptible; if cancellation wins the atomic outcome transition, it changes `queued -> cancelled`, removes the writer, wakes/re-evaluates the next head, and performs no mutation. If exclusive grant wins first, the writer token transfers atomically to the protected config application; cancellation cannot leave a granted-but-abandoned writer or interrupt that application. The sequence is uninterruptible through consistency. Response delivery may fail after completion if the client disconnected. Preserve existing schema/config 400 behavior and generic JSON 500 error boundary for unexpected persistence/application defects. Do not add 409/busy. Shutdown may interrupt queued requests; no persistent queue recovery is required.

## Project Structure

### Documentation (this feature)

```text
specs/003-safe-global-config-update/
├── plan.md
├── research.md
├── data-model.md
├── contracts/
│   └── global-config-update.md
└── quickstart.md
```

### Source Code (planned)

```text
packages/core/src/session/generation-gate.ts
packages/core/src/session/run-coordinator.ts
packages/core/src/session/execution/local.ts
packages/opencode/src/effect/runner.ts
packages/opencode/src/session/run-state.ts
packages/opencode/src/config/config.ts
packages/opencode/src/effect/instance-registry.ts
packages/opencode/src/project/instance-store.ts
packages/opencode/src/server/global-lifecycle.ts
packages/opencode/src/server/server.ts
packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts
packages/opencode/src/server/routes/instance/httpapi/server.ts

packages/core/test/generation-gate.test.ts
packages/core/test/session-run-coordinator.test.ts
packages/opencode/test/effect/runner.test.ts
packages/opencode/test/server/global-config-update.test.ts
```

**Structure Decision**: Keep the coordination primitive in `packages/core` and integrate at the existing V1 Runner, V2 coordinator, config, and InstanceStore ownership seams. Selectively acquire and inject only the gate service into isolated listener graphs. Tests are backend Effect tests; no frontend/browser test is used as invariant proof. V1 ownership coverage belongs in the existing `packages/opencode/test/effect/runner.test.ts`; no parallel RunState test file is needed.

## Complexity Tracking

No constitution violations. The one new shared service is required to establish a process-wide ordering boundary that current independent V1, V2, and global-config paths do not provide.
