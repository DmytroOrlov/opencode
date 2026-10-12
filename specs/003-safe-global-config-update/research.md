# Research: Safe Global Configuration Updates

## Scope and locked direction

The product semantics were clarified in the specification on 2026-09-28: ordinary changed `/global/config` requests wait for writer-fair exclusive ownership, apply in admission order without coalescing, and return only after consistent application. The architecture decisions below are fixed inputs from the adversarial review and four focused source bundles. This research records those choices and checks the adjacent repository APIs; it does not reopen architecture selection.

## Decisions

### One writer-fair generation gate

**Decision**: Add one Effect-backed `GenerationGate` in `packages/core`, with shared readers for V1/V2 generation work and exclusive writers for ordinary config application. Model `activeReaders`, `exclusiveActive`, and FIFO reader/writer waiters using short `SynchronizedRef` transitions and `Deferred` grants. Whenever no writer is active, admit the contiguous reader prefix at queue head together, even while earlier readers remain active; grant a writer only when it is the head and all active readers have drained. Do not let post-writer readers overtake it. Queued cancellation removes the waiter and reruns admission. Shared lease release is idempotent.

**Rationale**: The behavior gives both safety and writer fairness across every path. A short state mutation followed by waiting outside the state transition prevents a waiter from holding the coordination primitive while blocked. A reservation records order before deferred follow-up work begins.

**Alternatives considered**: Activity counts/maps, a config-only mutex, polling, frontend `session_status`, separate V1/V2 checks, and persist-first/defer-disposal are expressly rejected because they leave a check-then-act gap or expose inconsistent state.

### Reservation and lease ownership

**Decision**: A reservation has one atomic, mutually exclusive outcome transition, `queued -> cancelled` or `queued -> granted(lease)`. Queued cancellation removes the waiter, reruns head admission, and creates no lease. If grant wins, cancellation cannot pretend the waiter was removed. The granted lease is explicitly `reservation-owned` until a single atomic transfer to `work-owned`; interruption before transfer releases it exactly once, and after transfer only the actual RunHandle, ShellHandle, coordinator entry, or config application owns release. A released state prevents finalizers from both claiming ownership; idempotent release remains defensive. Exclusive wait is interruptible; after grant its token transfers to the protected application, which is uninterruptible through its consistency boundary.

**Rationale**: HTTP caller lifetime and generation/follow-up lifetime are not the same. Explicit ownership covers cancellation and deferred work without leaking admission.

### Process-global service identity and listener isolation

**Decision**: Keep one exact stable dependency-free `GenerationGate` layer as the implementation behind `GenerationGate.node`. Add a process-acquisition API that builds that exact layer against `@opencode-ai/core/effect/memo-map`'s module `memoMap` with a caller-supplied `Scope`, returning the service. This map owns/deduplicates only the gate acquisition. Keep each `Server.listen()` route graph on its existing fresh root memo map and inject a single `Layer.succeed(GenerationGate.Service, acquiredGate)` replacement into both separately compiled graph branches: the main app/V1/global-handler branch and the SessionV2 branch.

**Repository facts**:

- Reusing the exact stable layer through one `MemoMap` resolves one concrete service. That remains valid evidence for graphs built on the same map, but does not establish process-wide identity.
- `Server.Default()` / `HttpApiApp.webHandler()` use the module `memoMap`.
- `Server.listen()` calls `startListener()`, which builds `listenerLayer(...)` with a fresh `Layer.makeMemoMapUnsafe()` for each listener, using its own `Scope` and fresh ConfigProvider. This isolates listener HTTP/WebSocket/config/runtime resources and supports stop/restart semantics.
- The TUI worker may use both `Server.Default().app.fetch(...)` and `Server.listen(...)` in one process; multiple listener instances can also overlap. Thus same-map-only composition can create distinct gates for Default, listener 1, and listener 2.
- `createRoutes()` compiles a main app graph containing V1 `SessionRunState` and the environment that satisfies `globalHandlers`, plus a separately compiled `SessionV2.node` graph containing `SessionExecutionLocal.node`. The same already-acquired gate replacement must reach both branches.
- Acquire the process gate with the listener's scope before building the listener route layer. The gate layer observer is then released after listener-owned layers/resources are finalized. The scoped/ref-counted layer behavior is sufficient; no second process lifetime owner is needed.

**Alternatives considered and rejected**:

A. Building listener routes on the common process `memoMap` is rejected because it broadens listener resource sharing and lifetime beyond GenerationGate.

B. `Layer.forkMemoMapUnsafe(processMemoMap)` is rejected because child lookup can reuse any layer already memoized in the parent, including unrelated live AppRuntime/Default services, not only GenerationGate.

C. A module-global mutable `GenerationGate.Interface` or queue singleton is rejected by the architecture requirements.

**Selected rationale**: Use the existing process memo map only as the owner/deduplicator of the stable gate layer. Each listener obtains a scoped observer from it, then selectively injects only the resulting service into its otherwise isolated fresh route graph. Default/AppRuntime graphs compile the normal stable node against the module map. Concurrent observers share the same service. Stopping one observer cannot dispose the service while another remains; if all observers end and no process work remains, later acquisition may create an empty gate. No queue state is durable.

**Proof correction**: Retain the behavioral same-memoMap reader/writer test as Proof A. It is insufficient for process-wide identity. Phase B must also prove two process acquisitions with distinct live scopes return the same concrete service and preserve reader/writer behavior (Proof B), and prove separately fresh route/probe graph memo maps use one supplied replacement while unrelated local layers remain independently constructed (Proof C). Prefer direct service identity assertion as well as behavioral exclusion; ensure a writer fiber has had a deterministic scheduling opportunity before asserting it is queued (use a latch/yield only if the Effect seam requires it). Phase H then exercises real Default/AppRuntime versus listener paths and listener-to-listener paths.

### V2 coordinator ownership and pending wake

**Decision**: The V2 lease belongs to each coordinator-owned drain, not `SessionExecution.resume()` callers. Existing joins do not reserve new work. `pendingWake` is new future work and obtains a FIFO shared reservation when the wake is recorded. Pending state explicitly represents either a queued reservation or a granted-but-not-started lease. Before successor start, interruption cancels/removes the queued reservation or releases the already-granted lease; an active successor's coordinator entry releases normally. A successor waits on its own reservation after the current drain releases. Wake-before-writer and writer-before-wake ordering remains as specified.

**Local API check**: `packages/core/src/session/run-coordinator.ts` owns active entries, a `pendingWake` boolean, owner fibers, and `settle()`; `packages/core/src/session/execution/local.ts` wires `SessionExecution.resume/wake/interrupt` to that coordinator. This is the correct ownership seam. No adjacent type prevents associating a reservation with the pending follow-up state.

**Required order proofs**: wake before writer can proceed before that writer; writer before wake forces the successor behind the writer.

### V1 Runner transitions

**Decision**: Add lease-aware Runner transition operations, not a wrapper around the public `SessionRunState.ensureRunning()` call. Join already-owned Running or ShellThenRun work unchanged. For Idle starts, reserve shared admission, wait, re-resolve current per-directory `InstanceState` and Runner, atomically recheck, and either transfer ownership to a newly created handle or release the redundant lease and join/busy-fail. Shell-to-pending-run receives its own ordered reservation with queued, granted-but-not-transferred, and work-owned states: cancellation removes the queued waiter, releases a granted lease before transfer, and leaves release to the active RunHandle after transfer. Runner mutation locks are never held during gate waiting.

**Local API check**:

- `packages/opencode/src/effect/runner.ts` centralizes Runner state in `SynchronizedRef`, with `Idle`, `Running`, `Shell`, and `ShellThenRun` states and private Run/Shell/Pending handles. Its existing atomic `modifyEffect` transitions make it the correct place to make state checks and lease ownership transfer cohesive.
- `packages/opencode/src/session/run-state.ts` obtains Runner instances through per-directory `InstanceState`; this service can survive disposal and re-resolve fresh directory state. Therefore a waiter must resolve the Runner after waiting instead of retaining a stale Runner across global invalidation.
- `packages/opencode/src/session/prompt.ts` already funnels V1 generation through SessionRunState, so no semantic redesign is needed if it remains the authoritative seam.

**Conclusion**: No adjacent type/API incompatibility was found. The detailed lease-aware method signatures remain an implementation choice, subject to preserving the specified state semantics.

### Exclusive configuration application

**Decision**: Acquire the writer reservation before `Config.updateGlobal()` parses/merges/decodes or reads the effective config. Execute each update against the preceding committed config. Keep no-op writes inside the gate but skip disposal when `changed === false`. Do not coalesce payloads or precompute snapshots before admission.

**Local API check**: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` currently calls `Config.updateGlobal(payload)` and forks `disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })` for ordinary changed requests, returning early. The awaited disposal helper is already used by `/global/dispose`. The handler is the narrow operation boundary to replace; `/global/dispose` should keep its current intentional semantics.

### Atomic persistence API and commit point

**Decision**: Implement a private atomic replacement path only for `Config.updateGlobal()`: parse/merge/decode completely first, write unique same-directory temp content, preserve needed target metadata, rename temp over the target as the commit point, clean temp on pre-commit error, and invalidate global config cache only after rename succeeds.

**Local API check**:

- `packages/core/src/fs-util.ts`: `FSUtil.Interface extends FileSystem.FileSystem` and returns the underlying `fs` methods from `@effect/platform`. It has no existing atomic-write helper in the adjacent API.
- The installed `packages/core/node_modules/effect/src/FileSystem.ts` defines `rename(oldPath: string, newPath: string): Effect<void, PlatformError>` and `remove(path, options?: { recursive?: boolean; force?: boolean }): Effect<void, PlatformError>`. These signatures support a private same-directory temp rename and best-effort force cleanup.
- The platform surface exposes `stat`/`chmod`; implementation should preserve existing mode where required and use the exact platform-specific metadata available, without introducing a broad filesystem abstraction.

**Commit semantics**: Before rename, a failed update leaves the prior file/config effective. Rename is commit. After rename, config rollback is prohibited; recovery moves only forward through cache invalidation and instance eviction.

### Forward-only disposal and cache eviction

**Decision**: Invoke each registry callback behind an async/Effect boundary so synchronous throws and rejected promises both become settled outcomes; attempt all callbacks, log failures with directory/callback attribution, and ensure every selected `InstanceStore` cache entry is evicted after cleanup attempt, even when cleanup fails. Continue processing remaining entries. Cleanup defects do not restore old config.

**Local API check**:

- `packages/opencode/src/effect/instance-registry.ts` currently calls `Promise.allSettled([...disposers].map(disposer => disposer(directory)))`. Promise rejections settle, but synchronous callback throws can escape while constructing the array before `allSettled` begins.
- `packages/opencode/src/project/instance-store.ts`: `disposeEntry()` currently deletes the entry only after `disposeContext()` succeeds; `disposeAllOnce()` iterates entries and handles failed loads but a failed disposal can short-circuit remaining cleanup. Identity checks (`cache.get(directory) === entry`) can prevent deletion of a concurrently replaced entry.
- The planned `Effect.exit`/`ensuring`/identity-checked deletion can make cache eviction total while retaining cleanup defects as logged outcomes.

**Catastrophic-state conclusion**: With the current in-memory `Map` and synchronous identity-checked deletion, entry eviction itself is not an Effect failure point, so inability to establish eviction is not representable as an ordinary typed Effect failure. Callback and resource finalizer defects can be settled and logged while the forward consistency predicate is still met. Do not fabricate a recovery API. Only a process/runtime defect outside the typed flow could prevent the invariant; if implementation discovers a new fallible eviction boundary, retain exclusive admission until server recovery/termination rather than reopening readers.

### HTTP interruption and error behavior

**Decision**: Preserve existing 400 schema/config failures and root generic JSON 500 for unexpected defects. Do not add a busy/409 response. Writer cancellation races atomically with grant: cancellation winning while queued removes it with no mutation; grant winning transfers the token to protected application, which completes despite disconnect. Waiting generation reservations use the same rule, releasing a granted lease if interruption happens before ownership transfer. Shutdown may interrupt queued requests with no durable recovery.

**Local API check**: The global handler declares typed `BadRequest`; root `errorLayer` provides the generic JSON 500 defect boundary. The feature requires no additional typed 500 solely for persistence/application defects.

## Alternatives not selected

The user-selected architecture excludes activity snapshots, separate per-version gates, frontend-derived status, config-only locking, polling, payload coalescing, pre-lock write preparation, persist-first disposal, rollback after the replacement commit point, and a module-global mutable singleton. They are not candidates for implementation planning.
