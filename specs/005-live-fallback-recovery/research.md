# Research: Live Fallback Recovery

## Scope and evidence

This planning record uses the current checkout paths named in the feature request and the supplied established incident facts. Root-cause investigation and architectural alternatives are out of scope; the runtime-intent architecture and post-backoff boundary are locked. One planned assumption was later falsified by real transport evidence — the client-abort → server-writer-cancellation chain behind the original T015 — and the raw findings plus the corrected conclusions are recorded below rather than deleted.

## Findings

### Fallback is captured before processor recovery

`packages/opencode/src/session/prompt.ts` resolves persisted `config.get().fallback`, converts it into a `FallbackResolution`, and passes that value to `SessionProcessor.create`. `packages/opencode/src/session/processor.ts` stores the optional concrete resolution on its input and recovery facts reuse that captured value. Consequently, edits accepted after the processor begins do not reach its recovery decisions. The plan replaces this snapshot with an effectful resolver owned by the prompt/recovery path.

### Existing recovery owns failover safety

`packages/opencode/src/session/recovery.ts` implements the existing decision order and outcomes. An eligible fallback takes precedence over an unnecessary retry; replay-safe work restarts, settled tool work continues, and an executing tool with unknown outcome is terminal. It also represents disabled, same-model, already-used, unavailable-model, and unavailable-variant outcomes. Keep this engine as the only failover decision owner and preserve its rules.

### Retry decision currently precedes backoff

`packages/opencode/src/session/retry.ts` calls its recovery callback before computing/publishing retry status and next time, then schedules the delay. `packages/opencode/src/session/processor.ts` supplies that callback from the existing captured resolution. A fresh read only at that initial callback misses an edit made while status says “retrying.” Therefore recovery must be refreshed after the delay and immediately before the schedule permits another primary request. The schedule only authorizes or stops a primary retry; on stop, existing outer processor error handling resolves fresh state and executes failover/terminal handling.

### Global config remains behind GenerationGate

`packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` currently reserves exclusive `GenerationGate` admission, waits cancellably, transfers ownership, calls `Config.updateGlobal` with the full payload, performs disposal/event work, and releases the lease. `packages/core/src/session/generation-gate.ts` defines the reservation and ownership model. The runtime bridge stages only the fallback field before this wait; all persistence and destructive effects retain their current admission boundary. `Config.updateGlobal` in `packages/opencode/src/config/config.ts` remains the persistence path and is not changed to apply early.

### Process identity uses the established GenerationGate pattern

`packages/core/src/session/generation-gate.ts` has a stable global node and `acquireProcess`, built with the shared process `memoMap`. `packages/opencode/src/server/server.ts` acquires that service in `startListener` and passes the object to the listener. `packages/opencode/src/server/routes/instance/httpapi/server.ts` selectively replaces the node while building fresh route graphs. Runtime fallback intent will follow this exact identity/lifetime approach: acquire the one process service and selectively inject it into the graph containing prompt/recovery and the graph containing the global handler. No listener graph or memo map is made process-global.

### Serialized composer queue can strand newer fallback edits

`packages/app/src/pages/session/composer/prompt-model-selection.ts` serializes every model-pair mutation through one promise chain (`enqueue` builds on a `tail` promise). Its fallback persistence path `persist(next, apply, restore, commit)` does:

```text
optimistic serverSync().set("config", "fallback", next)
  -> await apply()
  -> await serverSync().updateConfig({ fallback: next })
  -> await commit?.()
  catch -> rollback serverSync().set(..., before); restore?.(); notify(error)
```

`selectFallback` and `selectFallbackVariant` both enter that chain (`prompt-model-selection.ts:267` and `:271`). The global config safety work deliberately lets that PATCH stay pending while an active generation holds shared `GenerationGate` admission, so the observed sequence is real: select B → operation B starts → PATCH B reaches the backend and can stage runtime intent B → the persistent PATCH B waits behind the active generation → `persist` for B is still awaiting `updateConfig` → the `tail` chain is still occupied. Selecting C at that moment only enqueues C behind B; `executeFallback(C)` never starts, PATCH C is never sent, and the backend runtime intent can never observe C. The same stall occurs for `B -> change variant` and `B -> clear fallback`.

**Why backend revisions alone are insufficient**: backend `stage`/`clearIfCurrent` revisions order the requests that actually arrive. They cannot order an intent that the client never transmits. Without a frontend supersession mechanism, the latest-intent requirement of FR-004 is unreachable through the real UI no matter how correct the server-side revision handling is.

### Excluding pair-routed direct fallback persistence recreates the same tail blockage

`selectFallback` is not always a simple fallback-only persist. In `executeFallback` (`prompt-model-selection.ts:208-224`), when the chosen item equals `primary()` and a fallback is currently displayed, `:216` awaits `swapInternal()` (`:154-177`). `swapInternal` computes the swapped pair, captures `const snapshot = selection.snapshot()` (`:167`), and calls `persist(next.fallback, setPrimary, snapshot.restore, commitPrimary)` (`:169-176`) — so a direct fallback edit can send its global fallback PATCH from inside pair work while the `tail` chain is occupied.

If that operation is declared non-abortable merely because its code path is "pair work", the deadlock returns unchanged: the pair-routed PATCH waits behind the active generation, the `tail` stays occupied, a newer `selectFallback(C)` receives a newer local revision but never starts, PATCH C is never transmitted, and backend runtime intent can never observe C — the exact failure the supersession seam exists to remove. Supersession eligibility therefore has to be keyed on the *originating user intent* (`selectFallback` / `selectFallbackVariant`, including explicit clear), not on whether the eventual `persist` call happens to carry pair side effects. Standalone `swap()`, `selectPrimary`, `selectVariant`, and `cycleVariant` originate from pair/model intents and stay outside the ownership class.

The unwind seam already exists and needs no second transaction mechanism: `swapInternal` passes `snapshot.restore` into `persist`, and `persist`'s `catch` (`:126-130`) already performs `serverSync().set("config", "fallback", before)` followed by `restore?.()`. Superseding a pair-routed direct fallback edit is that same path with `notify(error)` suppressed and `commit?.()` never reached.

### Exact request cancellation API

`serverSync().updateConfig` is `updateConfigMutation.mutateAsync` from `packages/app/src/context/server-sync.tsx:660` with `mutationFn: (config: Config) => serverSDK.client.global.config.update({ config })` (`server-sync.tsx:661`), exposed as `updateConfig: updateConfigMutation.mutateAsync` (`server-sync.tsx:688`). It currently takes no cancellation parameter.

`serverSDK.client` is the generated v2 client from `createOpencodeClient` (`packages/app/src/utils/server.ts:34`, constructed with `throwOnError: true` at `packages/app/src/context/server-sdk.tsx:339`). Its update method is generated as:

```ts
// packages/sdk/js/src/v2/gen/sdk.gen.ts:1298
public update<ThrowOnError extends boolean = false>(
  parameters?: { config?: Config3 },
  options?: Options<never, ThrowOnError>,
)
```

`Options` is `packages/sdk/js/src/v2/gen/client/types.gen.ts:196`, i.e. `OmitKeys<RequestOptions<...>, "body" | "path" | "query" | "url">`; `RequestOptions` (line 54) extends `Config` (line 10), which extends `Omit<RequestInit, "body" | "headers" | "method">`, so `signal?: AbortSignal | null` is part of the per-request options type. This is already exercised in production code: `packages/app/src/context/server-sdk.tsx:278` calls `eventSdk.global.event({ signal: attempt.signal })`, and `packages/app/src/context/file.tsx:215` passes a second-argument `{ signal: options?.signal }` to an SDK method.

Runtime propagation: `client.gen.ts` `request` spreads the options into `requestInit` and constructs `new Request(url, requestInit)` (`packages/sdk/js/src/v2/gen/client/client.gen.ts:71-77`), then awaits `_fetch(request)` (line 91), so aborting the supplied `AbortController` aborts the in-flight **client** request and its promise rejects. That is the entire required effect for the frontend seam: the old client promise settles promptly, the composer queue becomes available, and the newer PATCH can be transmitted. Per the transport finding below, this client-side abort is not a server-side cancellation signal once the complete request body has reached the server. The exact syntax is therefore:

```ts
serverSDK.client.global.config.update({ config }, { signal })
```

The smallest additive app API is `serverSync().updateConfig(config, options?: { signal?: AbortSignal })`, forwarding `{ signal }` as the generated client's second argument; callers that omit `options` keep today's behavior because `signal: undefined` is a no-op `RequestInit` field.

Abort rejections pass through `client.interceptors.error.use(wrapClientError)` (`packages/sdk/js/src/v2/client.ts:91`). `wrapClientError` returns `Error` instances unchanged but wraps non-`Error`, non-enumerable-shaped values (such as a `DOMException`) into a generic `Error("... network error (no response)")`, so error `.name === "AbortError"` is not a reliable discriminator across runtimes. Supersession must therefore be detected from controller-owned state (the local revision and the abort this controller itself issued), not from parsing the rejection.

### The planned client-abort → server-cancellation chain was falsified

The plan originally treated the following as a required chain:

```text
frontend AbortController.abort()
  -> real HTTP disconnect
  -> server request Effect interruption
  -> reservation.await interruption
  -> queued GenerationGate writer cancellation
```

That assumption is FALSE for the actual runtime. What was previously only "no existing proof" is now an attempted proof that failed, and the failure is the evidence that corrected the architecture.

**Failed real-listener attempt (first T015 implementation)**: a real `Server.listen()` test in `packages/opencode/test/server/global-config-update.test.ts` produced fallback B staged, writer B queued pre-transfer, `controller.abort()`, and a client fetch that rejected with `AbortError` — but the server's `reservation.await` remained alive, the writer remained queued, transfer count remained zero, and runtime B remained staged. The assertions that the queued reservation wait would be interrupted (`observeExclusiveReservations`'s `awaitInterrupted` queue) never fired.

**Framework-independent transport diagnostic (Bun + node:http)**: the lower-level reason was reproduced outside Effect:

```text
server receives full PATCH body
  -> request emits end
  -> request is complete

client aborts while waiting for response
  -> client fetch rejects AbortError

server receives no new request-aborted / response-close / socket-close
event attributable to that abort
```

Therefore, once the complete request has reached the server, client fetch cancellation is **not** a reliable server-side cancellation signal. This is NOT evidence that Effect request-scope wiring is broken; the request is simply complete from the server's point of view.

**Consequence**: no custom HTTP disconnect wiring, no server-side fallback-writer cancellation coordinator, no new endpoint, and no coalescing of ordinary `/global/config` writers are added. The handler fact remains true and unchanged — `configUpdate` in `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` wraps the handler in `Effect.uninterruptibleMask`, runs `reserveExclusive`, and only restores interruptibility for `restore(reservation.await)`, so the queue wait *is* cancellable in principle — but nothing in the production transport currently drives that cancellation for a request whose body has already fully arrived.

What the existing tests actually prove (unchanged, and deliberately not reinterpreted):

- `packages/opencode/test/server/global-config-update.test.ts:237` ("cancels a queued writer before grant…") and `:309` ("continues after transfer wins even when the request fiber is interrupted") both call `Fiber.interrupt(writer)`, where `writer` is `startPatch(...)` = `HttpClient.execute` forked as a child fiber (`:164-165`) against `NodeHttpServer.layerTest`. These interrupt an Effect request *fiber* in the test process; they are not an `AbortController` aborting a real client connection.
- `packages/opencode/test/server/httpapi-compression.test.ts:122-148` does use `AbortController`, but only against the in-memory `app().request(...)` surface, never a network listener.
- The nearest real seam is the Phase H test at `:492`, which builds `Server.listen({ hostname: "127.0.0.1", port: 0 })` (`startPhaseHListener`, `:471`) over `node:http` + `NodeHttpServer.layer` (`src/server/server.ts:203-218`), holds a real shared `GenerationGate` lease via `SessionRunState.ensureRunning`, sends a real `fetch` PATCH (`patchGlobalConfig`, `:481-490`), and observes the queued writer through `observeExclusiveReservations` (`:458-469`). The original version of this test aborted the request and asserted server-side cancellation; that version failed and is the falsified T015 recorded above.

Conclusion: the T015 requirement is replaced. It no longer asks for `client AbortSignal → server reservation cancellation`; it now proves the corrected cross-layer behavior (local abort frees the caller, a newer request reaches the server, revisioned runtime intent supersedes immediately, the old server writer may finish, durable ordering converges to the latest request).

### Retaining a locally superseded writer preserves the global config contract

Once the full request has reached the server and the caller stops waiting for its response, writer B simply finishing is expected, acceptable behavior:

- Accepted writers remain independent FIFO requests; no fallback-specific coalescing is introduced.
- No request is silently dropped by another client or request.
- Post-transfer and pre-transfer ownership semantics of `GenerationGate` remain unchanged.
- A locally superseded request can still finish server-side. This is ordinary distributed-request ambiguity, not a defect, and frontend supersession must not be reinterpreted as proof that the server request was cancelled.

The separation of concerns is therefore: frontend `AbortController` = local composer queue release mechanism; `FallbackRuntimeIntent` revision = latest live recovery intent; `GenerationGate` FIFO config writers = durable persistence ordering.

### Runtime intent covers the intermediate durable window

Consider generation A active, writer B queued, generation G2 queued after B, and writer C queued after G2. When A finishes, B may persist and G2 may be admitted before C persists. This is still correct because runtime C was staged as soon as PATCH C reached the server, so G2's fresh fallback resolver observes runtime C, not temporarily persisted B. C remains staged until its own request eventually completes. This is an explicit reason NOT to clear C merely because B completes: `clearIfCurrent` for B's older revision is a no-op against C's newer revision.

### Restart semantics: last persisted fallback wins over runtime-only intent

If B persisted successfully, C was only runtime-staged / still waiting, and the process exits before C persists, then after restart the runtime-only C is gone and the last successfully persisted fallback B is authoritative. This is consistent with the existing distinction that runtime acceptance != durable persistence success. No durable runtime-intent recovery is invented; `FallbackRuntimeIntent` remains process-local with no disk/database representation.

### Existing frontend optimistic update is retained

`packages/app/src/pages/session/composer/prompt-model-selection.ts` already accepts fallback selection while a session is working, applies the optimistic `serverSync().set("config", "fallback", ...)` when its queued operation executes, and issues the normal server update. Both behaviors stay. Only the later-edit submission gap described above is new work: the narrow frontend supersession seam is added alongside the server runtime-intent bridge, not in place of the existing optimistic update.

## Decisions

- **Decision**: Add one small process-wide, process-local `FallbackRuntimeIntent` service storing raw selection, revision, and override-presence state.
  **Rationale**: It bridges accepted fallback edits to existing active recoveries without representing pending state as durable config.
- **Decision**: Stage the owned `fallback` property before `GenerationGate.reserveExclusive`; keep the entire original payload's persistence and disposal work behind the existing grant/transfer boundary.
  **Rationale**: This makes only fallback intent live while retaining global config consistency for every other setting.
- **Decision**: Resolve raw selections at each eligible recovery boundary through current config/provider services and existing eligibility checks.
  **Rationale**: Provider model objects must be fresh and service-owned; the runtime-intent service should not duplicate fallback validation.
- **Decision**: Re-evaluate after retry backoff, before permitting another primary request, then leave failover execution to the processor's existing outer recovery path.
  **Rationale**: The initial call preserves existing status/backoff semantics, while the post-backoff call closes the incident window without creating another recovery engine.
- **Decision**: Cleanup is revision-conditional and runs on every persistence/request exit.
  **Rationale**: Older concurrent requests cannot erase a newer accepted choice; after cleanup, readers use the newest remaining runtime override or successfully persisted config.
- **Decision**: Give every direct fallback edit a controller-local revision at invocation time, before it enters the existing composer operation queue, and abort the active fallback persistence request when a newer direct edit arrives.
  **Rationale**: Backend revisions cannot order an intent that the client never transmits; invocation-time tagging plus aborting the old *client* request is the smallest change that lets C reach the server while B's persistence is still pending. The abort's required success criterion is local only: the old promise settles promptly, the queue frees, and the newer PATCH transmits — it is not a server-side writer cancellation.
- **Decision**: Skip a queued direct fallback operation whose local revision is no longer latest, and treat an abort issued for supersession as ordinary control flow rather than a persistence error.
  **Rationale**: Prevents stale PATCHes and stale rollbacks without swallowing genuine failures, and keeps the queue serialization for every other operation.
- **Decision**: Detect supersession from controller-owned revision/abort state rather than from the rejection's error name.
  **Rationale**: `wrapClientError` can reshape abort rejections, so error-name matching is not a reliable discriminator across runtimes.
- **Decision**: Key supersession eligibility on the originating direct fallback user intent (`selectFallback` incl. clear, `selectFallbackVariant`), so a pair-routed route such as `executeFallback` → `swapInternal` is supersedable too; keep standalone `swap()`, `selectPrimary`, `selectVariant`, and `cycleVariant` outside the ownership class.
  **Rationale**: Declaring pair-routed fallback persistence non-abortable would let one pair-routed PATCH re-occupy the composer tail and block every newer direct fallback edit, recreating the original deadlock.
- **Decision**: Unwind a superseded pair-routed direct fallback operation through the existing `persist` `catch` body — optimistic `set(before)` plus the `snapshot.restore` already passed in by `swapInternal` — suppressing only `notify(error)` and never reaching `commit`.
  **Rationale**: Reuses the pair failure path that already exists, so no second transaction mechanism is introduced and no half-applied swap survives.
- **Decision**: Replace the withdrawn T015 server-cancellation proof with a corrected real-transport regression at the existing Phase H `Server.listen` seam: B client-abort → C arrival → runtime-latest → FIFO convergence.
  **Rationale**: The original assumption (client abort cancels the queued server writer) was falsified by real evidence; the replacement proves what the corrected architecture actually depends on — the local abort frees the caller, a newer request reaches the server, revisioned runtime intent supersedes immediately, the old server writer may safely finish, and final durable ordering converges to the latest request.
- **Decision**: Do not add custom HTTP disconnect wiring, a server-side fallback-writer cancellation coordinator, a new endpoint, or fallback-specific coalescing of ordinary `/global/config` writers.
  **Rationale**: Client fetch cancellation after full body receipt is not observable server-side, and accepted writers already satisfy the established global config contract as independent FIFO requests. Retaining writer B is normal distributed-request ambiguity; frontend supersession is user-intent supersession, not server cancellation.
- **Decision**: Let a retained older writer finish under normal `GenerationGate` FIFO ordering, relying on revision-safe `clearIfCurrent` so B's completion cannot erase runtime C.
  **Rationale**: Ordering durability is decided by the gate's writer queue, not by client abort timing; runtime intent already carries the latest recovery state while both writers wait.
- **Decision**: Document restart as durability-only — if B persisted and C was only runtime-staged, restart makes B authoritative and runtime-only C is lost.
  **Rationale**: Runtime acceptance is not durable persistence success; inventing durable runtime-intent recovery would violate the no-durable-runtime-state constraint.

## Existing code reused unchanged

- `SessionRecovery` decision and tool-safety semantics.
- Provider model lookup and fallback parsing/normalization sources.
- `GenerationGate` reservation, grant, transfer, release, and fairness semantics.
- Full-payload `Config.updateGlobal` persistence and instance invalidation/disposal ordering.
- Existing prompt operation scope and retryability classification.
- The composer operation queue (`enqueue`/`tail`) as the single serializer for all model operations, the `persist` rollback + `onError` behavior for genuine failures, and the `selection.snapshot().restore` pair-unwind path (now also used when a superseded pair-routed direct fallback edit unwinds); only persistence that originates from a direct fallback edit gains revision tagging, an abort, and a supersession branch.

## Interfaces and contracts

No public API changes are planned. The existing `PATCH /global/config` endpoint remains the transport; no contract file is required. Runtime intent is internal and temporary. The one app-internal signature change is the additive optional cancellation parameter on `serverSync().updateConfig(config, options?: { signal?: AbortSignal })`; no other `updateConfig` caller changes and the generated config client itself is untouched.
