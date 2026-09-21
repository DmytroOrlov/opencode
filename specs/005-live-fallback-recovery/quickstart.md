# Quickstart: Live Fallback Recovery

## Primary deterministic regression

Add or extend a focused session retry/processor test using a controllable fake provider and `Deferred`/`Queue` synchronization:

1. Start one generation with no configured or runtime fallback.
2. Make primary A attempt 1 fail with a retryable error.
3. Wait for an explicit test signal that retry status/backoff has begun; hold the backoff at a controllable boundary rather than sleeping.
4. Stage fallback B as the latest runtime intent.
5. Release the backoff and observe the post-backoff recovery decision before allowing any provider request.
6. Assert that A attempt 2 was never dispatched, B was dispatched exactly once, and the original generation/assistant turn continued without another prompt.

Run the focused session tests after implementation:

```sh
bun test packages/opencode/test/session/retry.test.ts packages/opencode/test/session/processor-effect.test.ts packages/opencode/test/session/prompt.test.ts
```

## Latest-choice and dispatch-freeze cases

Use the same deterministic boundary to stage B and then C before releasing backoff; assert C dispatches and B does not. In a separate case stage B, then explicit `null`; assert no fallback dispatch and that existing retry/terminal behavior applies. Once B has been accepted for dispatch, stage C and assert the in-flight/accepted B attempt remains targeted at B.

## Cross-regression: runtime visibility with blocked persistence

Hold a shared `GenerationGate` lease for an active generation. Send the normal global config PATCH containing fallback B. Before releasing the shared lease, assert:

- the active recovery can read B from runtime intent;
- persistent `Config.updateGlobal` has not run;
- destructive disposal/invalidation has not run.

Then release the shared lease and assert the same HTTP request acquires writer ownership, persists the full payload, runs existing invalidation work, and reconciles its runtime revision. For a mixed PATCH, verify an unrelated field X remains unapplied until writer grant.

Run the focused server tests after implementation:

```sh
bun test packages/opencode/test/server/global-config-update.test.ts packages/opencode/test/server/httpapi-global.test.ts
```

## Additional focused checks

- Service tests: `packages/opencode/test/session/fallback-runtime-intent.test.ts` verifies no-override versus explicit-null state, monotonically increasing revisions, and stale `clearIfCurrent` no-op.
- Request ordering/reconciliation: stage R1/B, then R2/C; finish, fail, or cancel R1 and assert C remains current. Simulate persistence failure after runtime B has been consumed; assert the HTTP request fails, B is not durable, and subsequent resolution uses a newer runtime override or the last successfully saved config.
- Restart semantics (documented expectation, no new mechanism): if B persisted and C was only runtime-staged when the process exits, restart leaves runtime-only C gone and the persisted fallback B authoritative. Runtime acceptance is not durable persistence success.
- Abort: hold retry backoff, stage B, abort the generation, and assert neither B nor another primary attempt is dispatched.
- Existing recovery control: keep configured fallback B-before-generation fallback-first behavior and reuse existing recovery coverage for restart, settled-tool continuation, executing-tool terminal outcome, same-model, unavailable model/variant, and attempt limits.

All races use explicit synchronization and provider dispatch queues/counters. No validation relies on elapsed-time sleeps.

## Frontend cross-regression: superseding a pending B with C

Target chain, the UI half of the backend scenario above:

```text
B PATCH waiting behind active generation
  -> user selects C
  -> local abort settles B's client promise (composer queue released)
  -> C request reaches backend
  -> backend runtime intent becomes C (newer revision)
  -> server writer B stays queued and may still finish under FIFO
  -> next eligible recovery uses C; durable value converges to C
```

A global config PATCH may legitimately wait behind an active generation, so the composer must be able to release its own queue when the user changes intent again. The abort's required success criterion is only local: the old client promise settles/rejects promptly, the queue becomes available, and the newer PATCH can be transmitted. It is **not** expected to cancel the backend writer for B — once B's complete request body reached the server, B remains an accepted FIFO writer.

Deterministic controller test in `packages/app/src/pages/session/composer/prompt-model-selection.test.ts`, using the existing fake `serverSync` extended so `updateConfig(config, options?)` records the payload and rejects when `options.signal` aborts (deferred promise + abort listener, no sleeps). The held deferred stands in for the server holding B's persistent PATCH behind an active generation:

1. Start a session as working so the persistent PATCH can be held open, then `selectFallback(B)`; hold B's `updateConfig` on a deferred promise.
2. While B is pending, `selectFallback(C)`.
3. Assert:
   - B's client request observes the local `options.signal` abort and settles promptly (supersession is client-side only), and its operation resolves without rollback and without an `onError` entry;
   - C does not wait for B's persistence success — PATCH C is submitted as soon as B's client promise releases the queue (the server writer for B is untouched by this abort);
   - the optimistic displayed fallback is C, and stale B never restores B over C;
   - the backend, given C's request, stages runtime intent C (covered by the server-side latest-intent case above);
   - the next eligible recovery therefore dispatches C, not B.

Then the same harness with `B → C → D` before B's cancellation unwinds: stale queued C is skipped (no PATCH, no optimistic write), D is the next PATCH, and nothing stale commits after D. Variant change and explicit clear use the same harness with `selectFallbackVariant(...)` and `selectFallback(undefined)`; a genuine `updateConfig` rejection with no newer intent still rolls back and calls `onError`.

### Pair-routed supersession case

Same harness, but pick B so `selectFallback(B)` chooses the current primary and therefore routes through `swapInternal` (its PATCH still comes from a direct fallback edit, so it stays in the ownership class):

1. `selectFallback(B)` starts, performs its pair-local `apply()`, and its `updateConfig` is held pending.
2. Invoke `selectFallback(C)` before it completes.
3. Assert: B's client request observes the local `options.signal` abort (supersedable by origin, despite the pair path), settling the old promise without any assumption of backend cancellation; B's uncommitted pair-local mutation is restored through the existing `snapshot.restore` seam, so no half-applied swap remains; no ordinary B persistence error reaches `onError`; C runs through the existing serializer and PATCH C is submitted; the final pair/fallback state corresponds to C.
4. Control: explicit `swap()` invoked as a swap stays ordinary serialized pair work — it neither bumps the fallback revision nor aborts a pending fallback request (covered by the existing swap-atomicity test).

### Corrected real HTTP proof (T015): B abort → C arrival → runtime latest → FIFO convergence

The earlier T015 idea — client abort cancels the queued server writer — was **falsified**: a real `Server.listen()` run showed the server `reservation.await` staying alive after `controller.abort()`, and a Bun + node:http diagnostic showed the server receiving no request-aborted/close event once the full PATCH body had arrived. Do not restore that requirement and do not add artificial waits asserting B is cancelled server-side.

Extend the real-listener Phase H seam in `packages/opencode/test/server/global-config-update.test.ts` — real `Server.listen` + real `fetch` + real `AbortController`, with shared `GenerationGate` admission held — to prove the corrected behavior:

1. Hold shared `GenerationGate` admission, then send `fetch(new URL("/global/config", listener.url), { method: "PATCH", body: ..., signal: controller.signal })` containing fallback B.
2. Before abort, assert: runtime B staged (`intent.current()` shows B); writer B queued (`Config.updateGlobal` has not run; reservation observed through `observeExclusiveReservations`); transfer count zero; persisted fallback unchanged.
3. `controller.abort()`. Assert the client promise rejects promptly with the abort. Do **not** require the server writer to disappear: writer B remains pre-transfer and persistence stays blocked while shared admission is held.
4. While B is still server-side queued, send a real PATCH C.
5. Before releasing shared admission, assert: runtime intent is C at a newer revision; writer C is queued; persisted fallback is still the original value; B has not transferred.
6. Release shared admission and let normal writer ordering proceed.
7. Assert: B's stale completion/cleanup does not clear runtime C; C eventually persists; after C completes the runtime override clears; final persisted fallback is C; no lease/token leak remains (a later writer still reserves, transfers, and releases).

This proves: a local abort frees the caller, a newer request reaches the server, revisioned runtime intent supersedes live recovery immediately, the old server writer may safely finish, and final durable ordering converges to the latest request. It is deliberately not a re-run of the fiber-interruption tests at `global-config-update.test.ts:237`/`:309`, which interrupt a forked Effect request fiber rather than aborting a real client connection.

Run the focused frontend suite after implementation (from `packages/app`):

```sh
bun test --conditions=solid --preload ./happydom.ts ./src/pages/session/composer/prompt-model-selection.test.ts
```
