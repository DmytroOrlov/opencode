# Implementation Plan: Live Fallback Recovery

**Branch**: `005-live-fallback-recovery` | **Date**: 2026-09-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-live-fallback-recovery/spec.md`, requirements checklist, and the locked architecture in the planning request.

## Summary

Allow an active generation to observe the latest accepted fallback selection at its next eligible recovery decision, including a selection made during retry backoff. Keep persistent global configuration behind the existing exclusive `GenerationGate` boundary. Add a process-wide, revisioned runtime-intent service as a temporary bridge, resolve the fallback afresh through existing provider/config sources, and refresh recovery immediately after backoff before a retry can dispatch the primary again. `SessionRecovery` remains the sole owner of failover and replay-safety decisions.

Because the persistent global-config PATCH can now legitimately wait behind an active generation, the composer's serialized operation queue must no longer let an older pending fallback PATCH block a newer direct fallback edit from reaching the server. Add a narrow frontend supersession seam for direct fallback edits only: abort the older in-flight fallback *client* request so its promise settles promptly and the composer queue frees, and skip stale queued fallback edits by a controller-local revision, while the existing queue and model-pair atomicity stay intact. The `AbortController` is a local queue-release mechanism only — its required success criterion is that the old client promise settles, the queue becomes available, and the newer PATCH can be transmitted; it is **not** expected to cancel the backend writer. Supersession eligibility follows the *originating user intent*: a direct fallback edit that internally routes through swap/pair logic is still supersedable, and it unwinds its uncommitted pair-local state through the existing snapshot/restore path instead of committing it.

**Corrected transport fact (load-bearing)**: a real `Server.listen()` test and a framework-independent Bun + node:http diagnostic established that once the complete PATCH body has reached the server, client `fetch` cancellation produces only a local `AbortError` — the server receives no request-aborted/close event attributable to that abort, so `reservation.await` stays alive and the queued writer stays queued. Client abort is therefore not a server-side cancellation signal, and this is not evidence of broken Effect request-scope wiring. The architecture keeps T001–T004 unchanged and relies on three separate mechanisms: the frontend `AbortController` = local composer queue release; `FallbackRuntimeIntent` revision = latest live recovery intent; `GenerationGate` FIFO config writers = durable persistence ordering. No custom HTTP disconnect wiring, no server-side fallback-writer cancellation coordinator, no new endpoint, and no fallback-specific coalescing of ordinary `/global/config` writers are added.

## Technical Context

**Language/Version**: TypeScript; repository uses Bun and Effect.

**Primary Dependencies**: Effect services/layers, `LayerNode`, `GenerationGate`, `Config`, `Provider`, `SessionRecovery`, and `SessionRetry`.

**Storage**: Existing persistent global configuration remains authoritative for future work. Runtime intent is process-local and in-memory only.

**Testing**: Focused deterministic Bun tests using Effect `Deferred`, `Queue`, `Ref`, or existing provider and gate seams. Frontend controller tests use deferred promises and abort observation through the existing app test harnesses. Do not use sleep-based race tests.

**Target Platform**: OpenCode server process and its session-generation runtime, plus the app composer model-pair controller.

**Project Type**: TypeScript monorepo; OpenCode server application with shared core services and its app frontend.

**Performance Goals**: Runtime intent reads and writes are small in-memory operations. No polling, detached fibers, or added wait on runtime-intent reads. Preserve existing retry delay and status behavior. Frontend supersession is event-driven (invocation-time revision bump plus abort) with no added rendering or polling work.

**Constraints**: No new endpoint; no early or unsafe global-config mutation; no raw mutable module singleton; no durable runtime state; no changes to GenerationGate ownership/fairness, retryability classification, tool replay safety, or telemetry. No custom HTTP disconnect wiring, no server-side fallback-writer cancellation coordinator, and no coalescing of ordinary `/global/config` writers. Freeze a fallback target once accepted for dispatch. No detached config writes, no early success for pending persistence, no unrestricted concurrent composer mutation, and no weakening of the GenerationGate admission boundary.

**Scale/Scope**: One process-wide fallback intent observed independently by active generations and the existing global config PATCH handler; narrowly scoped server/session code and focused tests. One controller-local frontend supersession seam for direct fallback edits in the composer, plus focused app controller tests.

## Constitution Check

- **Principle I, Upstream- and Protocol-First Reuse**: No provider protocol capability applies. Use the existing provider source of truth and fallback resolver.
- **Principles II–IX, telemetry compatibility and lifecycle**: No telemetry behavior or data flow changes; existing telemetry remains observational and unchanged.
- **Principle X, Minimal, Evidence-Driven Change**: Reuse `SessionRecovery`, `GenerationGate`, provider resolution, existing config PATCH transport, and test harnesses. Add only the runtime-intent bridge, the fresh-resolution/retry seam, and the narrow direct-fallback supersession seam required by the incident.
- **Principle XI, Performance and UI Stability**: The only frontend production change is a controller-local supersession seam for direct fallback edits. No polling, no added rendering work, no generation-blocking work, and no change to composer queue ordering or model-pair atomicity.
- **Principle XII, Governance**: No constitution change is required.

**Gate result**: Pass. Design retains safe config admission and existing recovery ownership; no constitution exception is needed.

## Project Structure

### Documentation (this feature)

```text
specs/005-live-fallback-recovery/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── checklists/requirements.md
```

No `contracts/` directory is needed: the existing `PATCH /global/config` contract remains unchanged.

### Source Code (repository root)

```text
packages/opencode/src/session/
├── fallback-runtime-intent.ts   # new process-wide runtime intent service
├── prompt.ts                    # fresh fallback resolution and processor seam
├── processor.ts                 # effectful recovery resolver and outer recovery
├── recovery.ts                  # existing decision engine, semantics retained
└── retry.ts                     # post-backoff recovery refresh before retry dispatch

packages/opencode/src/server/
├── server.ts                    # acquire and bridge process service into listener
└── routes/instance/httpapi/
    ├── server.ts                # replace service node in fresh route graphs
    └── handlers/global.ts       # stage fallback before gate; reconcile by revision

packages/opencode/test/
├── session/retry.test.ts
├── session/fallback-runtime-intent.test.ts
├── session/prompt.test.ts
├── session/processor-effect.test.ts
├── server/global-config-update.test.ts  # existing gate coverage + T015 real HTTP B-abort → C-arrival → runtime-latest → FIFO convergence proof
└── server/httpapi-global.test.ts  # only if route-level request coverage is needed

packages/app/src/pages/session/composer/
├── prompt-model-selection.ts      # direct-fallback supersession: local revision, abort, stale skip, pair unwind
└── prompt-model-selection.test.ts # F1–F5, F7 supersession regressions; F6 keeps the pair-atomicity control

packages/app/src/context/
└── server-sync.tsx                # additive updateConfig(config, { signal? }) cancellation plumbing
```

**Structure Decision**: Keep the new service in the OpenCode session domain, adjacent to recovery. Add its stable global `LayerNode` and `acquireProcess` using the existing `GenerationGate` pattern. `Server.startListener` obtains the process instance; the server passes that exact service to `createRoutes`, which selectively replaces the service node in both the session/prompt graph and global-handler route graph. Listener graphs retain fresh memo maps and scopes.

**Frontend Structure Decision** (expected frontend production surface): exactly two production files change — `packages/app/src/pages/session/composer/prompt-model-selection.ts` (supersession state in `createModelPairController`, controller-local and never persisted) and `packages/app/src/context/server-sync.tsx` (widening `ServerSync.updateConfig` by an optional cancellation parameter only). Source inspection confirmed the cancellation plumbing is required because `updateConfig` currently exposes bare `updateConfigMutation.mutateAsync` with no way to pass a signal. No other app file changes; no change to the generic config client, the generated `global.config.update`, the TanStack mutation's success handling, or any other `updateConfig` caller.

## Design Decisions

1. **Runtime intent service**: Add `FallbackRuntimeIntent` in `packages/opencode/src/session/fallback-runtime-intent.ts`. Store raw fallback selection (`model` plus `variant`/`null`), revision, and the distinction between no override and explicit `null`. Expose only current snapshot, stage, and revision-conditional cleanup.
2. **Process identity**: Reuse `GenerationGate`'s stable `LayerNode`, process `memoMap` acquisition, and selective replacement into each fresh `Server.startListener` graph. The prompt/recovery and `/global/config` handler receive the same process service instance. Do not share listener graphs or add a raw module singleton.
3. **PATCH staging and reconciliation**: In `globalHandlers.configUpdate`, own-property-check `fallback`; stage only that property before reserving exclusive gate admission. Then retain the existing reserve, cancellable wait, transfer, full-payload `Config.updateGlobal`, invalidation/disposal/event, and writer-release order. In an ensuring/finalization path, call `clearIfCurrent` for the staged revision on success, failure, or cancellation. A stale completion cannot clear a newer revision. Unrelated fields in a mixed PATCH remain unapplied until writer admission.
4. **Fresh fallback resolution**: In `SessionPrompt`, provide the processor an effectful resolver rather than a captured `FallbackResolution`. At each resolution boundary it reads runtime intent first, otherwise persisted config, then applies existing turn-phase, same-model, already-used, model availability, variant availability, and provider-model resolution rules. `SessionRecovery` remains unchanged as the decision owner. Once its available fallback is returned for dispatch, the processor's selected attempt remains fixed even if a later intent revision appears.
5. **Post-backoff refresh**: Preserve the first recovery check and existing retry delay, status publication, and next timestamp. Extend the retry seam so a `retry_current` decision is re-evaluated after the backoff using the same failed attempt and a fresh resolver, immediately before another primary dispatch. A refreshed `retry_current` permits the next attempt; a failover or terminal decision ends the retry schedule and lets the existing outer processor recovery path handle the original failure with fresh resolution. The retry scheduler does not execute failover.
6. **Abort semantics**: Keep backoff under the generation's existing interruptible lifecycle. An interrupted schedule ends without running fallback dispatch or allowing another primary attempt; do not add detached recovery work.
7. **Frontend direct-fallback supersession**: Keep the existing `enqueue` promise chain in `createModelPairController` (`prompt-model-selection.ts`) as the single serializer for all model operations. Add controller-local ephemeral state equivalent to `latestFallbackIntentRevision` (monotonic counter) and `activeFallbackPersistenceAbortController` (the abortable owner of the currently executing persistence request that belongs to a direct fallback intent). Every direct fallback edit — `selectFallback` (including explicit clear) and `selectFallbackVariant` — receives a new local revision at invocation time, before it enters the queue, and invoking a newer direct edit aborts the active owner. That abort is a *local* release: its only required success criterion is that the old client promise settles/rejects promptly so the queue becomes available and the newer PATCH can be transmitted; it is never treated as a server-side writer cancellation (decision 11). When a queued direct fallback operation reaches execution, a revision that no longer equals the latest is superseded: it resolves immediately without optimistic `set`, without `updateConfig`, without `commit`, and without rollback — that skip happens before any side effect, so nothing needs unwinding (an operation already mid-flight when it turns stale follows decision 8 instead). This is the only concurrency exception; `selectPrimary`, `selectVariant`, `cycleVariant`, and `swap` remain queued, ordered, and pair-atomic, and invoking them while a fallback persistence is pending still waits for it exactly as today.
8. **Supersession eligibility follows the originating user intent, not the implementation path**: eligibility is decided by *why* the operation was invoked. `selectFallback(...)` (including explicit clear) and `selectFallbackVariant(...)` are direct fallback intents, and any global fallback persistence they perform is supersedable — including the pair-routed route where `executeFallback` chooses the current primary and awaits `swapInternal()` (`prompt-model-selection.ts:208-224` → `:154-177`), whose `persist` still sends a fallback PATCH while the `tail` is occupied. Such an operation registers `activeFallbackPersistenceAbortController` exactly like a simple fallback-only persist, so a newer `selectFallback(C)` is never blocked behind it. Standalone `swap()`, `selectPrimary`, `selectVariant`, and `cycleVariant` are ordinary serialized pair/model mutations: they never bump the local revision, never register the abortable owner, never abort another request, and are never skipped or unwound by supersession.

   **Pair unwind on supersession**: a superseded pair-routed operation must not commit, must not leave half of a swap applied locally, must not raise an ordinary persistence error, and must not hold the newer intent until the active generation ends. It reuses the existing mechanism: `swapInternal` already captures `const snapshot = selection.snapshot()` and passes `snapshot.restore` as `persist`'s `restore`, and `persist`'s `catch` already performs `serverSync().set("config", "fallback", before)` plus `restore?.()`. Supersession runs that same unwind and suppresses only `notify(error)`; `commit?.()` is never reached. No second pair transaction mechanism is introduced. The staleness check runs both when a queued operation starts (skip before any side effect) and again when its persistence settles (abort, rejection, or a request that resolved too late to cancel), so an operation that becomes stale mid-flight never commits.
9. **Cancellation plumbing**: Widen the existing `serverSync().updateConfig` to `updateConfig(config, options?: { signal?: AbortSignal })` and forward to the already-generated `serverSDK.client.global.config.update({ config }, { signal })`. Callers that omit `options` keep current behavior exactly. This is an additive app-internal parameter, not a new endpoint, not a new config client, and not a change to any other `updateConfig` caller.
10. **Supersession is not a persistence error**: In `persist`'s `catch`, a superseded *fallback-only* operation (no pair-local `apply()` work) returns without `serverSync().set("config", "fallback", before)`, without `restore?.()`, and without `notify(error)`; the newer queued edit owns the optimistic value. A superseded *pair-routed* operation runs the existing `set(before)` + `restore?.()` unwind from the same `catch` so no half-applied swap survives, but still never reaches `commit?.()` and still never calls `notify(error)` (decision 8). A genuine failure with no newer intent keeps the existing rollback + `onError` path for both shapes. Detection uses the controller-owned revision (and the abort this code itself issued), not the thrown error's `name`, because abort rejections from this client pass through `wrapClientError` and are not reliably `AbortError`-shaped across runtimes.
11. **Client abort is local only; server writers are never cancelled by it**: Aborting the older request releases only the client's wait — its promise rejects promptly, the composer queue frees, and the newer PATCH can be transmitted. Once the complete request body has reached the server, that abort produces no server-side cancellation signal (corrected transport fact above): `reservation.await` stays alive and writer B stays queued, so B is expected to finish normally under GenerationGate FIFO after shared admission releases. When B eventually completes, its `clearIfCurrent(N)` runs against current revision N+1 if C staged first and is therefore a no-op — an old request can never erase newer runtime intent — and if cleanup ran before C staged, C then stages at N+1. If B has already transferred exclusive writer ownership, the existing uninterruptible `Config.updateGlobal` + invalidation/disposal/event region still completes; frontend cancellation never interrupts it, and this GenerationGate invariant is unchanged by the client-side abort.

    **Retaining writer B is acceptable**: this preserves the established global config contract — accepted writers remain independent FIFO requests, no fallback-specific coalescing is introduced, no request is silently dropped by another client or request, and post-transfer/pre-transfer GenerationGate ownership semantics are unchanged. A locally superseded request can therefore still finish server-side; that is ordinary distributed-request ambiguity once the full request has already reached the server and the caller stops waiting for its response. Do not reinterpret frontend supersession as proof that the server request was cancelled. Backend writer ordering, not client abort timing, decides which write is durable; the newer request simply becomes the later intent in that same ordering.
12. **Three distinct acceptance states**: keep separate (a) frontend invocation — the optimistic displayed value, which may lead the server; (b) backend runtime-intent acceptance — C is only usable by active recovery once C's request reaches the server and stages its revision; (c) persistent success — only the completed protected global-config request may be reported as saved. A superseded request is none of these failures and is never surfaced to the user as one.
13. **Runtime intent covers the intermediate durable window**: with generation A active, writer B queued, generation G2 queued after B, and writer C queued after G2, A finishing may let B persist and G2 be admitted before C persists. This is still correct because runtime C was staged as soon as PATCH C reached the server, so G2's fresh fallback resolver observes runtime C rather than temporarily persisted B. C remains staged until its own request eventually completes; C is never cleared merely because B completes.
14. **Restart semantics are durability-only**: if B persisted successfully and C was only runtime-staged when the process exits, restart loses runtime-only C and the last successfully persisted fallback B is authoritative. Runtime acceptance is not durable persistence success, and no durable runtime-intent recovery is invented.

## Validation Design

Use deterministic synchronization to prove the ordering boundaries. Extend retry/prompt coverage for configured fallback, selection/change/clear during backoff, no second primary dispatch, fixed dispatched target, and abort. Extend global-config coverage to observe runtime staging before writer grant while persistence and disposal remain blocked, mixed-payload isolation, revision-safe stale cleanup, and persistence failure reconciliation. Retain existing `SessionRecovery` assertions for replay-safe restart, settled-tool continuation, executing-tool terminal behavior, retry limits, same-model, availability, and variant checks rather than duplicating the full recovery suite.

Frontend regressions live in `packages/app/src/pages/session/composer/prompt-model-selection.test.ts` and use deferred promises plus abort observation only (no sleeps), extending the existing fake `serverSync` so `updateConfig(config, options?)` records the payload and rejects when `options.signal` aborts:

- **F1 — pending B superseded by C**: `selectFallback(B)` starts and stays pending; `selectFallback(C)` is then invoked. Assert B's client request rejects promptly from the local abort (supersession), C does not await B's persistence success, PATCH C is submitted, the optimistic displayed fallback becomes C, stale B does not restore over C, and `onError` sees no B persistence error. The abort's success criterion is only the local one: the old promise settles, the queue frees, C transmits.
- **F2 — rapid B → C → D**: hold B pending, invoke C, then D before B's cancellation unwinds. Assert stale queued C is skipped (no PATCH, no optimistic apply), D is the next submitted PATCH, the final optimistic fallback is D, and no stale operation commits after D. This is the regression that proves local revision is required in addition to `AbortController`.
- **F3 — model → variant supersession**: B's model PATCH is pending; `selectFallbackVariant(...)` is invoked. Assert the old B payload is superseded and the new payload carrying B plus the latest variant is submitted without waiting for the active generation.
- **F4 — selection → explicit clear**: B's PATCH is pending; `selectFallback(undefined)` is invoked. Assert B is superseded, `{ fallback: null }` is submitted, the optimistic fallback becomes null, and stale B cannot restore itself.
- **F5 — genuine persistence failure**: no newer fallback intent exists and `updateConfig(B)` rejects. Assert the existing rollback and `onError` behavior still runs, proving supersession does not swallow real failures.
- **F6 — pair-ordering control**: reuse the existing controller tests that prove swap pair-atomicity and ordered fallback model/variant submission in the same file; add at most one focused case asserting a primary/swap operation queued behind direct fallback edits still runs in queue order after them. This is also the control that proves explicit `swap()` (and `selectPrimary`/`selectVariant`/`cycleVariant`) stays ordinary, non-supersedable serialized pair work: it neither bumps the fallback revision nor aborts a pending fallback request.
- **F7 — pair-routed fallback edit superseded**: build the condition where `selectFallback(B)` on the current primary routes through `swapInternal` / pair work and its global fallback PATCH is held pending. Before it completes, invoke `selectFallback(C)`. Assert: B's request is treated as supersedable *because its origin was a direct fallback edit* (not because its path was fallback-only), and its client request observes the abort signal so the local promise settles and the queue frees — with no assumption that the backend writer was cancelled; any uncommitted local pair mutation from B is restored through the existing snapshot/restore seam, leaving no half-applied swap; no ordinary B persistence error is surfaced; C proceeds through the existing serializer and PATCH C reaches the backend; the final local pair/fallback state corresponds to C.

Backend regressions are unchanged: fallback runtime-intent state/revision behavior, existing configured fallback control, fallback selected during retry backoff, no second primary dispatch after post-backoff refresh, backend B → C latest intent, explicit clear, runtime intent visible while the config writer is blocked, mixed PATCH isolation, stale backend request cleanup, persistence failure reconciliation, fallback dispatch freeze, abort during backoff, and existing `SessionRecovery` tool-safety controls. The backend B → C case proves server revision semantics; F1–F5 and F7 prove the real UI can get C to the server while B persistence is pending. Both are required.

**T015 — real HTTP B-abort → C-arrival → runtime-latest → FIFO convergence** (replaces the withdrawn server-cancellation proof): the earlier T015 assumption — client `AbortController` → HTTP disconnect → server request interruption → `reservation.await` interruption → queued writer cancellation — was **falsified** by a real `Server.listen()` run plus a Bun + node:http transport diagnostic (recorded in `research.md`). The corrected proof uses the existing real-listener seam in `packages/opencode/test/server/global-config-update.test.ts` (`startPhaseHListener`, real `fetch`, `observeExclusiveReservations`, real `Server.listen`, real `AbortController`) and proves the architecture the frontend actually depends on:

1. Hold shared `GenerationGate` admission, then send a real `PATCH /global/config` containing fallback B through `fetch(url, { method: "PATCH", signal: controller.signal })`.
2. Prove before abort: runtime B staged; writer B queued (`Config.updateGlobal` has not run; the reservation is observed via `observeExclusiveReservations`); transfer count zero; persisted fallback unchanged.
3. Abort the client fetch. Prove the client promise rejects promptly with the abort. Do **not** require the server writer B to disappear: writer B remains pre-transfer and persistence remains blocked while shared admission is held.
4. While B is still server-side queued, send a real PATCH C.
5. Prove before releasing the shared generation: runtime intent becomes C at a newer revision; writer C is queued; persisted fallback is still the original value; B has not transferred.
6. Release shared admission and allow normal writer ordering to proceed.
7. Prove: stale completion/cleanup of B does not clear runtime C; C eventually persists; after C completes the runtime override clears; final persisted fallback is C; and no lease/token leak remains (a later writer still reserves, transfers, and releases).

The test must use real `Server.listen()`, `fetch()`, and `AbortController`, must not add artificial waits asserting that B is cancelled server-side, and does not duplicate the existing GenerationGate cancellation tests: those two interrupt a forked Effect request fiber (`Fiber.interrupt(writer)`), and the in-memory compression abort tests never touch a listener. Its purpose is to prove: a local abort frees the caller, a newer request can reach the server, revisioned runtime intent supersedes live recovery immediately, the old server writer may safely finish, and final durable ordering converges to the latest request.

Post-design constitution check: pass. The runtime bridge is process-local, cleanup is revision-safe, persistent mutation keeps the current admission boundary, and recovery/tool safety remain owned by existing code. The frontend seam is controller-local and ephemeral, preserves queue ordering and pair atomicity (superseded pair-routed work unwinds through the existing snapshot/restore path rather than committing), adds no polling or rendering work, and never reports a superseded request as a persistence failure.

## Dependency-Ordered Implementation Sequence

1. Add the revisioned process-wide `FallbackRuntimeIntent` service and process-wire one acquired instance into fresh listener route and session graphs. *(T001–T002, complete.)*
2. Stage only an owned `fallback` field before exclusive admission in the existing global config handler, preserve full-payload persistence ordering, and reconcile the staged revision with `clearIfCurrent` on every exit. *(T003–T004, complete.)*
3. Implement the corrected T015 real HTTP proof (B client-abort → C arrival → runtime latest → FIFO convergence) and get it passing **before** resuming any recovery/frontend implementation; it validates the transport boundary every later task composes with.
4. Replace the processor's captured fallback snapshot with a fresh effectful resolver and add the post-backoff recovery refresh before retry dispatch; route non-retry decisions through existing outer processor recovery and retain abort behavior.
5. Add frontend direct-fallback request supersession: widen `serverSync().updateConfig` with an optional `signal`, tag direct fallback edits with a controller-local revision at invocation, abort the active persistence request owned by that intent when a newer direct edit arrives — including one that routed through `swapInternal` — unwind superseded pair-routed work through the existing `persist` `restore`/snapshot path without `commit` or `notify`, and skip stale queued fallback edits before any side effect, leaving the queue serializer and standalone pair operations unchanged.
6. Add the deterministic backend and frontend regressions described in Validation Design (F1–F7, T015, plus the existing backend cases) and run the focused suites. Backend commands stay as listed in `quickstart.md`; the frontend controller suite runs from `packages/app` as:

```sh
bun test --conditions=solid --preload ./happydom.ts ./src/pages/session/composer/prompt-model-selection.test.ts
```
