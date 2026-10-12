# Quickstart: Safe Global Configuration Update Validation

This guide defines focused backend validation for the implementation. It is a plan artifact only; no tests are added or run as part of planning.

## Prerequisites

- Bun and repository dependencies installed.
- Run commands from the repository root.
- Use the existing Effect/Vitest test conventions in the nearest core and opencode suites.
- Gate-order tests use `Deferred` or latches and explicit handshakes, never timing sleeps.

## Gate unit schedules

Add unit coverage for `GenerationGate` with controlled schedules:

1. **Writer fairness**: acquire G1 and G2; enqueue W1 then G3; release both readers; assert W1 is exclusive; release W1; assert G3 is admitted.
2. **Reader grant**: acquire W1; enqueue G1; release W1; assert G1 receives shared admission.
3. **Ordered multiple writers**: hold G1; enqueue W1, W2, then G2; release G1; assert W1, then W2, then G2.
4. **Cancelled tail reader**: hold G1; enqueue W1 then G2; cancel G2; release G1; assert W1 proceeds.
5. **Cancelled writer queue cleanup**: hold G1; queue W1 then G2; cancel W1; release G1; assert G2 proceeds and no cancelled reservation is retained.
6. **Cancellation wins the race**: hold G1; queue G2 behind W1 (or otherwise keep G2 blocked); cancel G2 before grant; open the grant opportunity; assert G2 never acquires and reader ownership does not leak.
7. **Grant wins the race**: arrange a latch at the atomic granted state; queue the next writer/reader; interrupt the requester before transfer to work; assert the reservation-owned lease is released exactly once and the next waiter proceeds.

The fixtures should expose reservation creation, grant observation, cancellation, release, and queue state only through narrow test seams. Avoid production introspection APIs solely for testing.

## Composition and integration schedules

Add backend tests that use deferred barriers at the actual ownership boundaries:

- Proof A: retain the existing behavioral reader/writer sharing proof when consumers use the same memo map.
- Proof B: acquire the stable process gate with two distinct live scopes and assert both return the same `GenerationGate.Interface` object. Then acquire/transfer a shared reader through gate A, queue an exclusive writer through gate B, prove the writer cannot grant, release the reader, and prove the writer grants. Use latches/Effect scheduling controls, never sleeps.
- Proof C: build two independent route/probe graphs using separately fresh root memo maps, supplying the same `Layer.succeed(GenerationGate.Service, acquiredGate)` replacement to each. Assert both resolve/use that exact gate while an unrelated local layer is separately constructed in each graph. This proves selective injection without sharing the general memo maps.
- Keep the Default/AppRuntime graph on its normal stable `GenerationGate.node` and the module process memo map. For listeners, acquire the process gate with the listener scope before building the listener route layer; inject the same replacement into both the main V1/global-handler graph and the separately compiled SessionV2 graph.
- Preserve listener lifetime validation: its own scope, fresh root memo map, HTTP/WebSocket resource cleanup, restart behavior, and fresh ConfigProvider based on current `process.env` remain isolated. Multiple listeners share only the gate service. Stopping one listener releases only its gate observer while other observers remain live.
- V1 RunHandle and ShellHandle each block a writer through terminal cleanup. A pending ShellThenRun reservation ordered before a writer proceeds before it; one ordered after it waits, then re-resolves fresh per-directory Runner state. If PendingHandle admission is granted but not transferred to RunHandle, cancellation releases that lease and lets a waiting writer proceed; after transfer, the active handle owns release.
- V2 active drain blocks a writer. A wake ordered before a writer runs before it; a wake ordered after a writer runs after it. If pendingWake is granted but the successor has not started, `interrupt()` releases that lease and lets a waiting writer proceed; an active successor releases through its coordinator lifecycle.
- Mixed V1 and V2 readers, including work from another directory/project, block the same writer. The exclusive writer blocks new readers from both versions.
- Real production topology proof: a Default/AppRuntime generation reader blocks a `/global/config` writer served by `Server.listen()`; also prove listener #1 generation reader blocks listener #2's `/global/config` writer (or reverse directions where fixture setup is cleaner). Include stop/restart with another live observer, owner-request reservation cleanup at normal listener shutdown, no durable recovery, and restart joining the currently observed gate. Do not use sleeps or timing assertions for ownership ordering.
- Two config writers apply independently in deterministic FIFO order. A changed request responds only after process-wide eviction; a no-op does not dispose.
- A persistence failure before rename leaves the prior effective config intact and removes its temporary file; a failure after rename follows forward recovery and never restores the old file.
- Exclusive admission race: cancellation before grant removes the writer with no config mutation; grant before cancellation transfers ownership to protected application, which completes invalidation and releases exclusive ownership despite HTTP interruption.
- Rejecting and synchronously throwing disposal callbacks are both attempted across selected entries; no old `InstanceStore` entry remains reusable.

Do not use frontend/browser tests as proof of the coordination invariant.

## Validation commands

After implementation, run the focused tests first, then relevant package checks:

```sh
bun test packages/core/test/generation-gate.test.ts
bun test packages/core/test/session-run-coordinator.test.ts
bun test packages/opencode/test/effect/runner.test.ts
bun test packages/opencode/test/server/global-config-update.test.ts
bun run typecheck
```

The V1 ownership cases live in the existing `packages/opencode/test/effect/runner.test.ts`; no separate RunState test file is required. Expected result: deterministic schedule assertions pass, process acquisition and selective listener injection proofs pass, and typecheck accepts the core service and both consumer graphs.

For end-to-end manual validation, start the server with one V1 generation and one V2 generation active, submit a changed global setting, and verify the HTTP request remains pending through both terminal cleanup boundaries, then completes only after old instances have been evicted. Repeat with the writer queued before new work and verify the new work starts after config application.
