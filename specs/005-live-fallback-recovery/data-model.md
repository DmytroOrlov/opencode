# Data Model: Live Fallback Recovery

## Persistent fallback configuration

Durable fallback setting in global configuration. A successfully completed `Config.updateGlobal` makes the selected value authoritative for future work. A pending or failed request is never represented as a successful persistent update.

## Runtime fallback intent

Process-local temporary state shared by active recovery and the existing global-config handler.

| Field | Meaning |
|---|---|
| `revision: number` | Monotonically increasing revision assigned atomically by every `stage` operation. |
| `override` | A tagged presence/value state: `none`, or `some(FallbackConfig \| null)`. |

`none` means there is no temporary override and fresh resolution reads successfully persisted configuration. `some(value)` means an accepted request currently overrides the persisted setting. `some(null)` is an explicit clear and must be distinguishable from an absent property or no override.

### Operations and transitions

- `current()` returns a consistent snapshot of revision and override state.
- `stage(value)` atomically increments revision, stores `some(value)` (including explicit `null`), and returns the new revision.
- `clearIfCurrent(revision)` clears the override only when its argument equals the current revision. The revision counter remains monotonic.

Stale completion protection is mandatory: if request R1 stages B at revision N and R2 stages C at N+1, any later success, failure, or cancellation cleanup for R1 calls `clearIfCurrent(N)` and has no effect. C remains current until its own reconciliation.

A client that aborts its own fetch does not stop R1 server-side: once the complete request body has reached the server, the client abort is not a server-side cancellation signal, so R1 remains an accepted FIFO writer and may apply normally after admission releases. This is intentional. Accepted writers stay independent FIFO requests with no fallback-specific coalescing and no silent drops, and revision-safe `clearIfCurrent` guarantees R1's completion cannot erase C.

Runtime intent also covers the intermediate durable window: with generation A active, writer B queued, generation G2 queued after B, and writer C queued after G2, A finishing may let B persist and G2 be admitted before C persists. G2's fresh fallback resolver still observes runtime C, because C was staged as soon as its PATCH reached the server — not temporarily persisted B. C is never cleared merely because B completes.

### Process lifetime and persistence reconciliation

The service has one effective identity per server process and no disk/database representation. It disappears at shutdown. On restart, only the last successfully persisted config is authoritative.

**Restart when B persisted but C had not**: if request B completed `Config.updateGlobal` successfully while request C was only runtime-staged or still waiting for writer admission, a process exit before C persists leaves runtime-only C gone after restart, and the persisted fallback B is authoritative. Runtime acceptance is deliberately not durable persistence success, and no durable runtime-intent recovery is invented — restart reasons only from successfully persisted configuration.

After a request's `Config.updateGlobal` and required disposal/event work succeeds, clear only that request's revision; readers then use persisted config. On failure or cancellation, likewise clear only that revision. A runtime fallback already dispatched remains a valid historical outcome, while the failed request reports persistence failure and is not treated as durable. A newer runtime revision remains visible through any older request cleanup.

The service stores raw fallback selection (`model` reference and variant or null), not a resolved provider model. Every generation resolves independently through current provider/config services and existing same-model, used-fallback, availability, variant, and tool-safety rules.

## Active generation and recovery decision

Each active generation owns its assistant turn, primary/active model, retry count, phase, used-fallback state, and executing/settled tool state. At each eligible failure boundary it resolves the current runtime override if present, otherwise persisted fallback, and submits those facts to the existing `SessionRecovery` decision engine. Multiple active generations may read the same global intent, but their eligibility and safety state remain independent.

The first recovery check occurs immediately after provider failure and retains existing retry-status scheduling. When it chooses `retry_current`, a second fresh check occurs after backoff and directly before another primary attempt is permitted. Only a fresh `retry_current` permits that request. A refreshed failover/terminal decision stops retry scheduling; the existing processor error path handles it.

## Fallback attempt dispatch snapshot

An available fallback returned for an accepted dispatch is a snapshot for that attempt. The processor updates turn phase and active model to the selected fallback. Later runtime edits may affect a later recovery decision but cannot mutate the selected model of an already-dispatched attempt. An aborted generation does not dispatch pending intent after interruption.

## Frontend ephemeral supersession state

Controller-local, in-memory-only state owned by `createModelPairController` in `packages/app/src/pages/session/composer/prompt-model-selection.ts`. Neither value is persisted, serialized, or visible to the server.

| Field | Meaning |
|---|---|
| `latestFallbackIntentRevision: number` | Monotonic counter bumped once per direct fallback **user intent** at invocation time, before the edit enters the composer operation queue. The revision belongs to the intent, not to any particular code path that intent later executes. |
| `activeFallbackPersistenceAbortController` | The `AbortController` (or `undefined`) that owns the currently executing global fallback persistence **belonging to a direct fallback intent** and can be aborted by a newer direct fallback intent. The owned request may be a simple fallback-only persist *or* a pair-routed one (e.g. `selectFallback` on the current primary routed through `swapInternal`). |

**AbortController meaning (corrected transport fact)**: aborting the active owner is a *local* composer-queue release, not a backend writer cancellation. Its required success criterion is only: the old client promise settles/rejects promptly → the composer queue becomes available → the newer PATCH can be transmitted. It is not expected to cancel the backend writer; once the complete request body has reached the server, the client abort produces no server-side cancellation signal, so the superseded server request may still finish under normal `GenerationGate` FIFO ordering. Its revision-safe cleanup cannot erase a newer staged revision, so a locally superseded request completing server-side is expected behavior rather than a failure.

A **direct fallback intent** is selecting or changing the fallback model, changing the fallback variant, or explicitly clearing the fallback — whichever internal route it ends up taking. Supersession eligibility follows that origin:

- **In the ownership class**: `selectFallback(...)` (incl. explicit clear) and `selectFallbackVariant(...)`, including a pair-routed execution of either. Their pending global fallback persistence is supersedable, and their uncommitted pair-local state is restorable.
- **Outside the ownership class**: standalone `swap()`, `selectPrimary`, `selectVariant`, and `cycleVariant`. These are ordinary serialized pair/model mutations: they never bump the revision, never register the abortable owner, never abort another request, and are never skipped or unwound by supersession. The operation queue keeps their existing pair-atomicity.

Transitions:

- A direct fallback intent increments the revision, aborts the active owner if one exists (settling that old client promise locally so the queue frees), then enqueues itself.
- When a queued direct fallback operation starts, `operationRevision === latestFallbackIntentRevision` means it proceeds; otherwise it is superseded before any side effect and resolves with no optimistic write, no PATCH, no commit, and no rollback.
- A fallback persistence owned by a direct fallback intent registers itself as the active owner before calling `updateConfig` and clears the owner on completion if it still is the owner. A pair-routed execution registers the same owner.
- On rejection or a settlement that turns out stale, `operationRevision !== latestFallbackIntentRevision` means supersession: no `notify`. A fallback-only operation also skips rollback and restore (the newer edit owns the optimistic value); a pair-routed operation **does** run the existing `set(before)` + `snapshot.restore` unwind so no half-applied swap survives, and in either case `commit` is never reached.
- Equality of revision means a genuine persistence failure and keeps the existing rollback + `onError` path.

Pair-routed supersession therefore reuses the existing pair failure seam (`swapInternal` captures `selection.snapshot()` and passes `snapshot.restore` into `persist`); no second pair transaction mechanism and no extra state field exist for it.

**Frontend and backend revision numbers are unrelated.** The frontend counter orders user intent inside one controller instance; the backend `FallbackRuntimeIntent` revision orders requests that reached the server. They are never compared, never shared, and never persisted. Frontend supersession decides what to transmit; backend revisions decide what is currently staged for recovery; `GenerationGate` FIFO writer ordering decides what becomes durable.
